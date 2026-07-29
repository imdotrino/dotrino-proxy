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
 * ID DE NODO: 12 caracteres DERIVADOS de la llave del nodo, no declarados. Como
 * cualquiera puede recalcularlos de la pubkey y se verifican al recibirlos, usar
 * el id de otro exige su llave privada — y por eso NADIE tiene que admitir a un
 * nodo nuevo en la red. Lo único que se acepta o no es una arista, y eso lo
 * decide cada operador. El id va delante de la instancia (para rutearla
 * leyéndola) y sus 2 primeros caracteres viajan en la cita como filtro.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// El alfabeto vive en alphabet.js: es el mismo para el id de nodo y para la
// cita, y tenerlo duplicado era pedir que se desincronizaran.
const { ALPHABET: ALLOWED_CHARS } = require('./alphabet');

// El id de nodo va DENTRO de la instancia, que nadie lee nunca, así que acá
// alargar es gratis. 12 caracteres del alfabeto de 29 son ≈ 3,5·10^17: moler una
// llave para caer en el id de otro cuesta del orden de 170.000 años, y por eso
// NADIE TIENE QUE ADMITIR NADA — reclamar el id ajeno exige su llave privada.
const NODE_ID_LEN = 12;

// Los 2 primeros caracteres del id viajan en el código corto como FILTRO, no
// como reclamo: sirven para saber a qué peers preguntarles. Pueden repetirse
// entre nodos sin que importe (se pregunta a todos los que coincidan, que en la
// práctica es uno), y como salen del id derivado, un nodo NO puede contestar por
// un código cuyo filtro no le corresponde.
const CODE_HINT_LEN = 2;

function canonicalStringify(obj) {
    if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

/**
 * Forma CANÓNICA de una pubkey P-256: el punto comprimido SEC1 de 33 bytes
 * (`02`/`03` según la paridad de `y`, seguido de `x`).
 *
 * Es imprescindible hashear esto y NO el JWK serializado: el mismo par de llaves
 * exportado por Node y por el navegador produce strings con los campos en otro
 * orden (está documentado en dotrino-vault/lib/src/invite.js), así que un id
 * derivado del string CAMBIARÍA al re-exportar la misma llave. El punto
 * comprimido depende solo del material de la llave.
 */
function canonicalPubkeyBytes(pubkeyJson) {
    const jwk = typeof pubkeyJson === 'string' ? JSON.parse(pubkeyJson) : pubkeyJson;
    if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
        throw new Error('pubkey no es una JWK EC P-256');
    }
    const x = Buffer.from(jwk.x, 'base64url');
    const y = Buffer.from(jwk.y, 'base64url');
    if (x.length !== 32 || y.length !== 32) throw new Error('coordenadas de longitud inesperada');
    const prefix = (y[31] & 1) === 0 ? 0x02 : 0x03;
    return Buffer.concat([Buffer.from([prefix]), x]);
}

/**
 * Id de nodo derivado: sha256(punto comprimido) convertido a la base del
 * alfabeto, NODE_ID_LEN caracteres.
 *
 * Se hace por conversión de base sobre un entero, no byte a byte con `% N`: 256
 * no es múltiplo del tamaño del alfabeto, así que el reparto por byte sesga los
 * primeros símbolos — irrelevante para colisiones, pero deja de ser cierto que
 * el id es uniforme, y sobre esa uniformidad se apoya el cálculo de molido.
 */
function deriveNodeId(pubkey) {
    const h = crypto.createHash('sha256').update(canonicalPubkeyBytes(pubkey)).digest();
    let n = BigInt('0x' + h.toString('hex'));
    const base = BigInt(ALLOWED_CHARS.length);
    let out = '';
    for (let i = 0; i < NODE_ID_LEN; i++) {
        out = ALLOWED_CHARS[Number(n % base)] + out;
        n /= base;
    }
    return out;
}

function isValidNodeId(id) {
    return typeof id === 'string' && id.length === NODE_ID_LEN &&
        [...id].every((c) => ALLOWED_CHARS.includes(c));
}

/** El filtro que viaja en el código corto: los 2 primeros del id de nodo. */
function hintOf(nodeId) {
    return typeof nodeId === 'string' ? nodeId.slice(0, CODE_HINT_LEN) : '';
}

/**
 * ¿El id que declara este nodo se corresponde con su llave?
 * Sin esta comprobación el id es una DECLARACIÓN (se lo queda el primero que lo
 * diga) y hace falta que alguien la valide; con ella es una PRUEBA, y no hay
 * nada que admitir.
 */
function nodeIdMatches(nodeId, pubkey) {
    try { return isValidNodeId(nodeId) && deriveNodeId(pubkey) === nodeId; }
    catch (_) { return false; }
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

    // El id NO se puede fijar a mano. Antes había un `PROXY_NODE_PREFIX` que
    // ganaba sobre el derivado, y eso apagaba justo la propiedad que sostiene
    // todo: si el id se declara, alguien tiene que validar la declaración (y de
    // ahí salía la pregunta de "quién admite un nodo nuevo"). Derivado y
    // verificado, no hay nada que admitir.
    const nodeId = deriveNodeId(device.publickey);

    return {
        pubkey: device.publickey,             // JWK serializado (string), como en identify
        privateJwk: device.privateJwk,
        nodeId,
        hint: hintOf(nodeId)
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
    // El alfabeto no se re-exporta: se importa de alphabet.js, que es su único
    // dueño. Tener dos nombres públicos dejaba la migración a "un solo sitio" a
    // medias y es cómo vuelven a aparecer las copias.
    NODE_ID_LEN,
    CODE_HINT_LEN,
    canonicalStringify,
    canonicalPubkeyBytes,
    deriveNodeId,
    isValidNodeId,
    hintOf,
    nodeIdMatches,
    loadNodeIdentity,
    signBody,
    verifyBody,
    ReplayWindow,
    newNonce
};
