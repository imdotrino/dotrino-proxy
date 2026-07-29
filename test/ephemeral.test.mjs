import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import {
    startNode, makeNodeDir, connectTo, connectIdentified, makeUser, freePort, sleep
} from './fedHelpers.mjs';

// Mensajes EFÍMEROS: el camino por pubkey encola 24 h, que es correcto para un
// chat y veneno para el tráfico de tiempo real (jugadas, señalización WebRTC).
// Con `ephemeral:true` se entrega si el destinatario está, y si no se descarta.
describe('envío efímero', () => {
    let a, b, dirA, dirB;

    beforeAll(async () => {
        dirA = makeNodeDir('eph-a');
        dirB = makeNodeDir('eph-b');
        const portA = await freePort();
        const portB = await freePort();
        [a, b] = await Promise.all([
            startNode({ name: 'A', dir: dirA, port: portA, prefix: 'K7', peers: [`http://127.0.0.1:${portB}`] }),
            startNode({ name: 'B', dir: dirB, port: portB, prefix: 'M2', peers: [`http://127.0.0.1:${portA}`] })
        ]);
        const deadline = Date.now() + 30000;
        for (;;) {
            const states = await Promise.all([a, b].map((n) => fetch(`${n.http}/peers`).then(r => r.json()).catch(() => null)));
            if (states.every((s) => s && Object.values(s.mesh || {}).some((m) => m.ready))) break;
            if (Date.now() > deadline) throw new Error('la malla no se estableció');
            await sleep(300);
        }
    }, 60000);

    afterAll(async () => {
        await Promise.all([a?.stop(), b?.stop()]);
        for (const d of [dirA, dirB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
    });

    it('se entrega normal si el destinatario está conectado (mismo nodo)', async () => {
        const alice = makeUser();
        const ca = await connectIdentified(a.url, alice);
        const cb = await connectTo(a.url);
        const payload = 'jugada-e4';
        cb.send({ to_publickey: alice.publickey, message: payload, ephemeral: true });
        const got = await ca.waitFor((m) => m.type === 'message' && m.message === payload);
        expect(got.message).toBe(payload);
        await ca.close(); await cb.close();
    });

    it('cruza al otro nodo si el destinatario está allá', async () => {
        const alice = makeUser();
        const ca = await connectIdentified(a.url, alice);
        const cb = await connectTo(b.url);
        const payload = 'jugada-cruzada-' + Date.now();
        cb.send({ to_publickey: alice.publickey, message: payload, ephemeral: true });
        const got = await ca.waitFor((m) => m.type === 'message' && m.message === payload);
        expect(got.message).toBe(payload);
        await ca.close(); await cb.close();
    });

    it('NO se encola cuando el destinatario está ausente: se descarta', async () => {
        const ausente = makeUser();
        const cb = await connectTo(b.url);
        cb.send({ to_publickey: ausente.publickey, message: 'sdp-caducado', ephemeral: true, id: 'eph-1' });
        const res = await cb.waitFor((m) => m.type === 'message_sent');
        expect(res.dropped).toContain(ausente.publickey);
        expect(res.queued).toEqual([]);

        // Y al conectarse después NO recibe nada: es la diferencia con la cola.
        const ca = await connectIdentified(a.url, ausente);
        const nada = await ca.waitFor((m) => m.type === 'message', 1500).catch(() => null);
        expect(nada).toBeNull();
        await ca.close(); await cb.close();
    }, 20000);

    it('un mensaje NORMAL al mismo ausente sí espera en la cola', async () => {
        const ausente = makeUser();
        const cb = await connectTo(b.url);
        cb.send({ to_publickey: ausente.publickey, message: 'hola, cuando puedas', id: 'norm-1' });
        const res = await cb.waitFor((m) => m.type === 'message_sent');
        expect(res.queued).toContain(ausente.publickey);
        expect(res.dropped).toBeUndefined();

        // Se conecta al nodo que lo encoló y lo recibe.
        const cbb = await connectIdentified(b.url, ausente);
        const got = await cbb.waitFor((m) => m.type === 'message' && m.message === 'hola, cuando puedas', 6000);
        expect(got.message).toBe('hola, cuando puedas');
        await cbb.close(); await cb.close();
    }, 20000);
});
