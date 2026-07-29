import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import {
    startNode, makeNodeDir, connectTo, connectIdentified, makeUser, freePort, sleep
} from './fedHelpers.mjs';

const peersOf = (node) => fetch(`${node.http}/peers`).then(r => r.json()).catch(() => null);

async function waitMeshReady(nodes, ms = 30000) {
    const deadline = Date.now() + ms;
    for (;;) {
        const states = await Promise.all(nodes.map(peersOf));
        const allUp = states.every((s) => s && s.peers?.length &&
            Object.values(s.mesh || {}).some((m) => m.ready));
        if (allUp) return states;
        if (Date.now() > deadline) throw new Error('la malla no se estableció: ' + JSON.stringify(states));
        await sleep(300);
    }
}

describe('malla s2s por WebSocket', () => {
    let a, b, dirA, dirB, portA, portB;

    beforeAll(async () => {
        dirA = makeNodeDir('mesh-a');
        dirB = makeNodeDir('mesh-b');
        portA = await freePort();
        portB = await freePort();
        [a, b] = await Promise.all([
            startNode({ name: 'A', dir: dirA, port: portA, prefix: 'K7', peers: [`http://127.0.0.1:${portB}`] }),
            startNode({ name: 'B', dir: dirB, port: portB, prefix: 'M2', peers: [`http://127.0.0.1:${portA}`] })
        ]);
        await waitMeshReady([a, b]);
    }, 60000);

    afterAll(async () => {
        await Promise.all([a?.stop(), b?.stop()]);
        for (const d of [dirA, dirB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
    });

    it('los dos nodos establecen el enlace saliente', async () => {
        const [sa, sb] = await Promise.all([peersOf(a), peersOf(b)]);
        expect(Object.values(sa.mesh).some((m) => m.ready)).toBe(true);
        expect(Object.values(sb.mesh).some((m) => m.ready)).toBe(true);
    });

    it('entrega un mensaje cruzado por la malla y lo acusa', async () => {
        const alice = makeUser();
        const ca = await connectIdentified(a.url, alice);
        const cb = await connectTo(b.url);
        const payload = 'malla-' + Date.now();
        cb.send({ to_publickey: alice.publickey, message: payload });
        const got = await ca.waitFor((m) => m.type === 'message' && m.message === payload);
        expect(got.message).toBe(payload);

        // El acuse deja el buffer de reenvío vacío: si no llegara, la trama se
        // quedaría guardada para siempre y se reenviaría en cada reconexión.
        await sleep(300);
        const sb = await peersOf(b);
        const link = Object.values(sb.mesh)[0];
        expect(link.acked).toBeGreaterThan(0);
        expect(link.pending).toBe(0);
        await ca.close(); await cb.close();
    });

    it('mantiene el ORDEN de una ráfaga cruzada', async () => {
        const alice = makeUser();
        const ca = await connectIdentified(a.url, alice);
        const cb = await connectTo(b.url);
        const n = 25;
        for (let i = 0; i < n; i++) cb.send({ to_publickey: alice.publickey, message: `orden-${i}` });
        await ca.waitFor((m) => m.type === 'message' && m.message === `orden-${n - 1}`, 10000);
        const recibidos = ca.recv.filter((m) => m.type === 'message' && /^orden-\d+$/.test(m.message))
            .map((m) => Number(m.message.split('-')[1]));
        expect(recibidos).toEqual(Array.from({ length: n }, (_, i) => i));
        await ca.close(); await cb.close();
    });

    it('reenvía lo pendiente cuando el peer vuelve', async () => {
        const alice = makeUser();
        const ca = await connectIdentified(a.url, alice);
        // Se cae el nodo A (el receptor). B sigue vivo y le siguen escribiendo.
        await a.stop();
        await ca.close();
        const cb = await connectTo(b.url);
        const payload = 'tras-caida-' + Date.now();
        cb.send({ to_publickey: alice.publickey, message: payload });
        await sleep(400);
        // A vuelve con su misma base y su misma identidad.
        a = await startNode({ name: 'A2', dir: dirA, port: portA, prefix: 'K7', peers: [`http://127.0.0.1:${portB}`] });
        await waitMeshReady([a, b], 40000);
        // Alice reconecta a A y se identifica: A es su home, así que le baja lo
        // encolado mientras estaba caído.
        const ca2 = await connectIdentified(a.url, alice);
        const got = await ca2.waitFor((m) => m.type === 'message' && m.message === payload, 15000);
        expect(got.message).toBe(payload);
        await ca2.close(); await cb.close();
    }, 90000);

    it('rechaza un nodo entrante que no está pineado', async () => {
        const require = (await import('module')).createRequire(import.meta.url);
        const WebSocket = require('ws');
        const crypto = require('crypto');
        const { signBody } = require('../nodeIdentity');
        const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
        const intruder = {
            pubkey: JSON.stringify(kp.publicKey.export({ format: 'jwk' })),
            privateJwk: kp.privateKey.export({ format: 'jwk' }),
            prefix: 'ZZ'
        };
        const ws = new WebSocket(`ws://127.0.0.1:${a.port}/_s2s`);
        const closeCode = await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('no cerró a tiempo')), 10000);
            ws.on('message', (raw) => {
                const f = JSON.parse(raw.toString());
                if (f.t === 'challenge') {
                    const body = { v: 1, op: 's2s-hello', from: intruder.pubkey, prefix: 'ZZ', nonce: f.nonce, ts: Date.now() };
                    ws.send(JSON.stringify({ t: 'hello', body, signature: signBody(intruder, body) }));
                }
                if (f.t === 'ready') { clearTimeout(t); reject(new Error('¡aceptó a un nodo desconocido!')); }
            });
            ws.on('close', (code) => { clearTimeout(t); resolve(code); });
            ws.on('error', () => {});
        });
        expect(closeCode).toBe(1008);
    }, 20000);

    it('rechaza un hello con el nonce de otra sesión (anti-replay)', async () => {
        const require = (await import('module')).createRequire(import.meta.url);
        const WebSocket = require('ws');
        const ws = new WebSocket(`ws://127.0.0.1:${a.port}/_s2s`);
        const closeCode = await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('no cerró a tiempo')), 10000);
            ws.on('message', (raw) => {
                const f = JSON.parse(raw.toString());
                if (f.t === 'challenge') {
                    // Nonce inventado, no el que mandó este servidor.
                    ws.send(JSON.stringify({ t: 'hello', body: { v: 1, from: 'x', nonce: 'nonce-de-otra-sesion', ts: Date.now() }, signature: 'x' }));
                }
            });
            ws.on('close', (code) => { clearTimeout(t); resolve(code); });
            ws.on('error', () => {});
        });
        expect(closeCode).toBe(1008);
    }, 20000);
});
