/**
 * EL DIRECTORIO DE LLAVES DE CIFRADO: el proxio como BUZÓN, no como autoridad.
 *
 * Sellar un mensaje dirigido necesita la llave de cifrado del otro lado, y hasta ahora no
 * había de dónde sacarla: solo podían sellar dos puntas emparejadas de antemano. Todo lo
 * demás —una sala, una invitación, un acuse a alguien apagado— iba en claro por un VPS
 * alquilado.
 *
 * Lo que se prueba aquí es lo que hace que esto no sea un agujero nuevo:
 *   · el anuncio se guarda solo si lo firmó la identidad de la que habla;
 *   · la consulta devuelve el SOBRE ENTERO, para que quien pregunta verifique él mismo;
 *   · nadie puede anunciar por otro;
 *   · un anuncio viejo no puede retroceder la llave de nadie.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, stopTestServer, connectClient } from './helpers.mjs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { generateKeyPairSync, sign: signSync } = require('crypto');

const ENCPUB_AUD = 'dotrino:encpub';

function canonicalStringify(obj) {
    if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

/** Una identidad de prueba: llave de firma + llave de cifrado, como cualquier aparato. */
function makeIdentity() {
    const sig = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const enc = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const sj = sig.publicKey.export({ format: 'jwk' });
    const ej = enc.publicKey.export({ format: 'jwk' });
    return {
        publickey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: sj.x, y: sj.y }),
        encPub: JSON.stringify({ kty: 'EC', crv: 'P-256', x: ej.x, y: ej.y }),
        sign: (data) => signSync('sha256', Buffer.from(canonicalStringify(data), 'utf8'),
            { key: sig.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64')
    };
}

function encPubBody(id, ts = Date.now()) {
    return { v: 1, op: 'encpub', aud: ENCPUB_AUD, publickey: id.publickey, encpub: id.encPub, ts };
}

async function identify(client, id) {
    const data = { op: 'identify', publickey: id.publickey, token: client.token, ts: Date.now() };
    client.send({ type: 'identify', data, signature: id.sign(data) });
    return client.waitFor((m) => m.type === 'identified');
}

// `fromNow` en los dos: un test manda varias cosas por la misma conexión y `waitFor`
// mira también lo YA recibido, así que sin esto la segunda respuesta es la primera.
async function announce(client, id, { body, signer } = {}) {
    const data = body || encPubBody(id);
    const esperada = client.waitFor((m) => m.type === 'encpub-announced' || m.type === 'error', { fromNow: true });
    client.send({ type: 'encpub', data, signature: (signer || id).sign(data) });
    return esperada;
}

async function lookup(client, publickeys) {
    const esperada = client.waitFor((m) => m.type === 'enc-lookup' || m.type === 'error', { fromNow: true });
    client.send({ type: 'enc-lookup', publickeys });
    return esperada;
}

describe('directorio de llaves de cifrado', () => {
    let url;
    beforeAll(async () => { ({ url } = await startTestServer()); });
    afterAll(async () => { await stopTestServer(); });

    it('anuncia y devuelve el sobre ENTERO, no solo la llave', async () => {
        const ana = makeIdentity();
        const c = await connectClient(url);
        await identify(c, ana);
        const res = await announce(c, ana);
        expect(res.type).toBe('encpub-announced');
        expect(res.stored).toBe(true);

        // Otro, que no se ha emparejado con ella ni la conoce de nada.
        const otro = await connectClient(url);
        const r = await lookup(otro, [ana.publickey]);
        expect(r.keys).toHaveLength(1);
        // El sobre completo: sin la firma, quien pregunta tendría que fiarse del proxio.
        expect(r.keys[0].data.encpub).toBe(ana.encPub);
        expect(typeof r.keys[0].signature).toBe('string');
        expect(r.keys[0].data.publickey).toBe(ana.publickey);
        await c.close();
        await otro.close();
    });

    it('el anuncio del anuncio ajeno NO entra: nadie anuncia por otro', async () => {
        const ana = makeIdentity();
        const bruto = makeIdentity();
        const c = await connectClient(url);
        await identify(c, bruto);
        // Firmado por ana (válido) pero anunciado desde la conexión de bruto.
        const res = await announce(c, ana);
        expect(res.type).toBe('error');

        const r = await lookup(c, [ana.publickey]);
        expect(r.keys).toHaveLength(0);
        expect(r.missing).toEqual([ana.publickey]);
        await c.close();
    });

    it('la llave de otro con MI firma no cuela', async () => {
        const ana = makeIdentity();
        const ladron = makeIdentity();
        const c = await connectClient(url);
        await identify(c, ana);
        // El cuerpo dice que es de ana, pero la firma es del ladrón: así es como se
        // sustituiría la llave para poder leer.
        const res = await announce(c, ana, { signer: ladron });
        expect(res.type).toBe('error');
        await c.close();
    });

    it('sin identificarse no se anuncia', async () => {
        const ana = makeIdentity();
        const c = await connectClient(url);
        const res = await announce(c, ana);
        expect(res.type).toBe('error');
        await c.close();
    });

    it('un anuncio viejo NO retrocede la llave', async () => {
        const ana = makeIdentity();
        const c = await connectClient(url);
        await identify(c, ana);
        await announce(c, ana);

        // El mismo perfil, llave de cifrado distinta, pero fechado ANTES.
        const vieja = makeIdentity();
        const cuerpoViejo = { ...encPubBody(ana, Date.now() - 60_000), encpub: vieja.encPub };
        const res = await announce(c, ana, { body: cuerpoViejo });
        expect(res.type).toBe('encpub-announced');
        expect(res.stored).toBe(false);

        const r = await lookup(c, [ana.publickey]);
        expect(r.keys[0].data.encpub).toBe(ana.encPub);
        await c.close();
    });

    it('lo que no está se dice en `missing`, no se calla', async () => {
        const nadie = makeIdentity();
        const c = await connectClient(url);
        const r = await lookup(c, [nadie.publickey]);
        expect(r.keys).toHaveLength(0);
        expect(r.missing).toEqual([nadie.publickey]);
        await c.close();
    });

    it('una llave de cifrado que no es P-256 se rechaza al entrar', async () => {
        const ana = makeIdentity();
        const c = await connectClient(url);
        await identify(c, ana);
        const cuerpo = { ...encPubBody(ana), encpub: 'no-soy-un-jwk' };
        const res = await announce(c, ana, { body: cuerpo });
        expect(res.type).toBe('error');
        await c.close();
    });

    it('`connected` dice el protocolo y lo que sabe hacer', async () => {
        const ws = new (require('ws'))(url);
        const frame = await new Promise((resolve, reject) => {
            ws.on('message', (raw) => resolve(JSON.parse(raw.toString())));
            ws.on('error', reject);
        });
        expect(frame.type).toBe('connected');
        expect(frame.protocol).toBe(2);
        expect(frame.speaks).toContain(1);
        expect(frame.caps).toContain('encpub');
        ws.close();
    });
});
