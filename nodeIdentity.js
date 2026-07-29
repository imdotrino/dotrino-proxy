/**
 * Identidad criptográfica del NODO (para hablar con otros proxies).
 *
 * Hasta la fase 1 los proxies se autenticaban entre sí con un secreto simétrico
 * compartido (`PROXY_FEDERATION_TOKEN`): quien lo tuviera podía inyectar mensajes
 * por `/federate` haciéndose pasar por cualquier nodo, y el secreto vivía en texto
 * plano en el config de PM2. Ahora cada nodo FIRMA lo que manda con su propia
 * llave y el receptor verifica contra la pubkey del emisor: no hay secreto que
 * compartir, y un nodo no puede hablar en nombre de otro.
 *
 * La llave sale de `vault-service/service-identity.json`, que el nodo ya tiene
 * por estar enrolado al vault del ecosistema (ver vaultSecrets.js). No se genera
 * una llave nueva: la identidad de red del nodo es la misma con la que el vault
 * lo conoce.
 *
 * PREFIJO DE NODO: dos caracteres del alfabeto de tokens que identifican al nodo
 * dentro del ecosistema. Se usa para cualificar los códigos de emparejamiento
 * (fase 4) y los canales (fase 5), de modo que un código diga a qué nodo hay que
 * preguntarle en vez de tener que pregonarlo a toda la malla. Por defecto se
 * DERIVA de la pubkey del nodo (verificable por cualquiera, sin registro), y se
 * puede fijar a mano con PROXY_NODE_PREFIX cuando el directorio asigna uno.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Mismo alfabeto que los tokens (tokenManager.js): sin 0 ni minúsculas, para que
// un prefijo se pueda dictar por teléfono sin ambigüedad.
const ALLOWED_CHARS = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PREFIX_LEN = 2;

function canonicalStringify(obj) {
    if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

/**
 * Prefijo derivado de la pubkey: sha256(pubkey) → 2 símbolos del alfabeto.
 * Verificable por cualquiera (no hace falta confiar en lo que el nodo declara),
 * pero NO exclusivo: moler llaves hasta caer en un prefijo elegido es barato. La
 * exclusividad, cuando importe, la da el directorio firmado — no este derivado.
 */
function derivePrefix(pubkey) {
    const h = crypto.createHash('sha256').update(String(pubkey), 'utf8').digest();
    let out = '';
    for (let i = 0; i < PREFIX_LEN; i++) out += ALLOWED_CHARS[h[i] % ALLOWED_CHARS.length];
    return out;
}

function isValidPrefix(p) {
    return typeof p === 'string' && p.length === PREFIX_LEN &&
        [...p].every((c) => ALLOWED_CHARS.includes(c));
}

/**
 * Carga la identidad del nodo desde el directorio del servicio del vault.
 * Devuelve null si el nodo no está enrolado (self-hoster sin vault): en ese caso
 * no puede federar con firma y el arranque lo dice claro.
 */
function loadNodeIdentity(dir) {
    const file = path.join(dir, 'service-identity.json');
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
    const device = raw && raw.device;
    if (!device || !device.publickey || !device.privateJwk) return null;

    const envPrefix = (process.env.PROXY_NODE_PREFIX || '').trim().toUpperCase();
    if (envPrefix && !isValidPrefix(envPrefix)) {
        throw new Error(`PROXY_NODE_PREFIX inválido: "${envPrefix}" (esperado ${PREFIX_LEN} caracteres de ${ALLOWED_CHARS})`);
    }

    return {
        pubkey: device.publickey,             // JWK serializado (string), como en identify
        privateJwk: device.privateJwk,
        prefix: envPrefix || derivePrefix(device.publickey)
    };
}

function privateKeyObject(privateJwk) {
    return crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
}

/** Firma un cuerpo con la llave del nodo (ECDSA P-256, ieee-p1363, JSON canónico). */
function signBody(identity, body) {
    return crypto.sign(
        'sha256',
        Buffer.from(canonicalStringify(body), 'utf8'),
        { key: privateKeyObject(identity.privateJwk), dsaEncoding: 'ieee-p1363' }
    ).toString('base64');
}

/** Verifica un cuerpo firmado contra la pubkey (JWK serializado) de un nodo. */
function verifyBody(body, signatureBase64, pubkeyJson) {
    try {
        const jwk = typeof pubkeyJson === 'string' ? JSON.parse(pubkeyJson) : pubkeyJson;
        if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) return false;
        if (typeof signatureBase64 !== 'string' || signatureBase64.length < 10) return false;
        const keyObject = crypto.createPublicKey({
            key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk'
        });
        return crypto.verify(
            'sha256',
            Buffer.from(canonicalStringify(body), 'utf8'),
            { key: keyObject, dsaEncoding: 'ieee-p1363' },
            Buffer.from(signatureBase64, 'base64')
        );
    } catch (_) {
        return false;
    }
}

/**
 * Anti-replay para tramas s2s: ventana de tiempo + memoria de nonces vistos.
 * Sin esto, capturar una trama firmada y reenviarla la re-entrega cuantas veces
 * se quiera (la firma sigue siendo válida para siempre).
 */
class ReplayWindow {
    constructor(windowMs = 5 * 60 * 1000) {
        this.windowMs = windowMs;
        this.seen = new Map();  // nonce -> ts
    }

    /** true si la trama es fresca y no repetida (y la registra). */
    accept(nonce, ts) {
        const now = Date.now();
        if (!Number.isFinite(ts) || Math.abs(now - ts) > this.windowMs) return false;
        if (typeof nonce !== 'string' || nonce.length < 8) return false;
        if (this.seen.has(nonce)) return false;
        this.seen.set(nonce, now);
        if (this.seen.size > 10000) this.prune();
        return true;
    }

    prune() {
        const cutoff = Date.now() - this.windowMs;
        for (const [nonce, ts] of this.seen) {
            if (ts < cutoff) this.seen.delete(nonce);
        }
    }
}

const newNonce = () => crypto.randomBytes(12).toString('base64url');

module.exports = {
    ALLOWED_CHARS,
    PREFIX_LEN,
    canonicalStringify,
    derivePrefix,
    isValidPrefix,
    loadNodeIdentity,
    signBody,
    verifyBody,
    ReplayWindow,
    newNonce
};
