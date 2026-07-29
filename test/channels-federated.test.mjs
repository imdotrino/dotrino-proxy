import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import { createRequire } from 'module';
import {
    startNode, makeNodeDir, connectTo, freePort, sleep
} from './fedHelpers.mjs';

const require = createRequire(import.meta.url);
const crypto = require('crypto');

// Canal con NODO DUEÑO: el nombre lleva delante el prefijo del proxio que lo
// hospeda (`K7/mesa-42`). Ese nodo guarda la membresía y los demás le pasan las
// operaciones. Así un servicio vive siempre en el mismo proxio y dos personas en
// nodos distintos SÍ aparecen en la misma lista — sin que cada consulta le
// pregunte a toda la malla ni que todos los peers se enteren de quién está dónde.
function canonical(obj) {
    if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
    return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

function makeChannelSigner() {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = kp.publicKey.export({ format: 'jwk' });
    const publickey = JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });
    return (name) => {
        const data = { name, publickey };
        const signature = crypto.sign('sha256', Buffer.from(canonical(data), 'utf8'),
            { key: kp.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
        return { data, signature };
    };
}

describe('canales con nodo dueño', () => {
    let a, b, dirA, dirB;

    beforeAll(async () => {
        dirA = makeNodeDir('chan-a');
        dirB = makeNodeDir('chan-b');
        const portA = await freePort();
        const portB = await freePort();
        [a, b] = await Promise.all([
            startNode({ name: 'A', dir: dirA, port: portA, prefix: 'K7', peers: [`http://127.0.0.1:${portB}`] }),
            startNode({ name: 'B', dir: dirB, port: portB, prefix: 'M2', peers: [`http://127.0.0.1:${portA}`] })
        ]);
        const deadline = Date.now() + 30000;
        for (;;) {
            const s = await Promise.all([a, b].map((n) => fetch(`${n.http}/peers`).then(r => r.json()).catch(() => null)));
            if (s.every((x) => x && x.peers?.length && Object.values(x.mesh || {}).some((m) => m.ready))) break;
            if (Date.now() > deadline) throw new Error('la malla no se estableció');
            await sleep(300);
        }
    }, 60000);

    afterAll(async () => {
        await Promise.all([a?.stop(), b?.stop()]);
        for (const d of [dirA, dirB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
    });

    it('un canal sin prefijo sigue siendo local a cada nodo', async () => {
        const sign = makeChannelSigner();
        const ca = await connectTo(a.url);
        const cb = await connectTo(b.url);
        ca.send({ type: 'publish', channel: sign('sala-local') });
        await ca.waitFor((m) => m.type === 'published');
        cb.send({ type: 'list', channel: sign('sala-local') });
        const lista = await cb.waitFor((m) => m.type === 'channel_list');
        expect(lista.tokens).toHaveLength(0);   // no se ven entre nodos
        await ca.close(); await cb.close();
    }, 20000);

    it('dos personas en nodos distintos aparecen en la MISMA lista', async () => {
        const sign = makeChannelSigner();
        const nombre = 'K7/mesa-compartida';
        const ca = await connectTo(a.url);   // en el nodo dueño
        const cb = await connectTo(b.url);   // en el otro nodo

        ca.send({ type: 'publish', channel: sign(nombre) });
        await ca.waitFor((m) => m.type === 'published');
        cb.send({ type: 'publish', channel: sign(nombre) });
        await cb.waitFor((m) => m.type === 'published', 10000);

        cb.send({ type: 'list', channel: sign(nombre) });
        const lista = await cb.waitFor((m) => m.type === 'channel_list', 10000);
        expect(lista.tokens).toContain(ca.token);
        expect(lista.tokens).toContain(cb.token);
        await ca.close(); await cb.close();
    }, 30000);

    it('el miembro que ya estaba se entera del que entra desde otro nodo', async () => {
        const sign = makeChannelSigner();
        const nombre = 'K7/mesa-avisos';
        const ca = await connectTo(a.url);
        ca.send({ type: 'publish', channel: sign(nombre) });
        await ca.waitFor((m) => m.type === 'published');

        const cb = await connectTo(b.url);
        cb.send({ type: 'publish', channel: sign(nombre) });
        await cb.waitFor((m) => m.type === 'published', 10000);

        const joined = await ca.waitFor((m) => m.type === 'joined' && m.token === cb.token, 10000);
        expect(joined.channel).toBe(nombre);
        await ca.close(); await cb.close();
    }, 30000);

    it('el aviso de baja llega al miembro que está en OTRO nodo', async () => {
        const sign = makeChannelSigner();
        const nombre = 'K7/mesa-bajas';
        const ca = await connectTo(a.url);   // dueño
        const cb = await connectTo(b.url);   // remoto
        ca.send({ type: 'publish', channel: sign(nombre) });
        await ca.waitFor((m) => m.type === 'published');
        cb.send({ type: 'publish', channel: sign(nombre) });
        await cb.waitFor((m) => m.type === 'published', 10000);
        await ca.waitFor((m) => m.type === 'joined', 10000);

        const se_va = ca.token;
        await ca.close();
        const aviso = await cb.waitFor((m) => m.type === 'disconnected' && m.token === se_va, 10000);
        expect(aviso.channel).toBe(nombre);
        await cb.close();
    }, 30000);

    it('contar un canal ajeno da el número del dueño, no cero', async () => {
        const sign = makeChannelSigner();
        const nombre = 'K7/mesa-cuenta';
        const ca = await connectTo(a.url);
        ca.send({ type: 'publish', channel: sign(nombre) });
        await ca.waitFor((m) => m.type === 'published');

        const cb = await connectTo(b.url);
        cb.send({ type: 'channel_count', channel: nombre });
        const cuenta = await cb.waitFor((m) => m.type === 'channel_count', 10000);
        expect(cuenta.count).toBe(1);
        await ca.close(); await cb.close();
    }, 30000);

    it('un canal de un nodo desconocido responde error, no una lista vacía', async () => {
        const sign = makeChannelSigner();
        const cb = await connectTo(b.url);
        cb.send({ type: 'list', channel: sign('ZZ/sala-fantasma'), id: 'zz' });
        const res = await cb.waitFor((m) => m.type === 'error' || m.type === 'channel_list', 10000);
        expect(res.type).toBe('error');
        expect(res.error).toMatch(/nodo desconocido/i);
        await cb.close();
    }, 20000);
});
