import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import {
    startNode, makeNodeDir, connectTo, connectIdentified, makeUser, freePort, sleep
} from './fedHelpers.mjs';

// Federación entre DOS NODOS REALES (procesos aparte, bases separadas, peers
// cruzados). Cubre lo que hasta la fase 1 no tenía ni un test, y que por eso
// llevaba meses roto en producción sin que nadie se enterara.
describe('federación entre dos nodos', () => {
    let a, b, dirA, dirB;

    beforeAll(async () => {
        dirA = makeNodeDir('a');
        dirB = makeNodeDir('b');
        const portA = await freePort();
        const portB = await freePort();
        [a, b] = await Promise.all([
            startNode({ name: 'A', dir: dirA, port: portA, prefix: 'K7', peers: [`http://127.0.0.1:${portB}`] }),
            startNode({ name: 'B', dir: dirB, port: portB, prefix: 'M2', peers: [`http://127.0.0.1:${portA}`] })
        ]);
        // Esperar al descubrimiento MUTUO (GET /node + pineo). Los dos nodos
        // arrancan a la vez, así que el primero encuentra al otro caído y tiene
        // que reintentar: por eso se espera a que los dos sentidos estén listos,
        // no un tiempo fijo.
        const deadline = Date.now() + 30000;
        for (;;) {
            const [pa, pb] = await Promise.all([
                fetch(`${a.http}/peers`).then(r => r.json()).catch(() => ({ peers: [] })),
                fetch(`${b.http}/peers`).then(r => r.json()).catch(() => ({ peers: [] }))
            ]);
            if (pa.peers?.length && pb.peers?.length) break;
            if (Date.now() > deadline) throw new Error('los nodos no se pinearon mutuamente a tiempo');
            await sleep(300);
        }
    }, 60000);

    afterAll(async () => {
        await Promise.all([a?.stop(), b?.stop()]);
        for (const d of [dirA, dirB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
    });

    describe('anuncio de nodo', () => {
        it('cada nodo publica un anuncio autofirmado con su prefijo', async () => {
            const res = await fetch(`${a.http}/node`);
            expect(res.status).toBe(200);
            const ann = await res.json();
            expect(ann.body.v).toBe(1);
            expect(ann.body.prefix).toBe('K7');
            expect(typeof ann.body.pubkey).toBe('string');
            expect(typeof ann.signature).toBe('string');
        });

        it('los dos nodos tienen prefijos distintos', async () => {
            const [annA, annB] = await Promise.all([
                fetch(`${a.http}/node`).then(r => r.json()),
                fetch(`${b.http}/node`).then(r => r.json())
            ]);
            expect(annA.body.prefix).not.toBe(annB.body.prefix);
            expect(annA.body.pubkey).not.toBe(annB.body.pubkey);
        });
    });

    describe('/federate exige firma de un peer pineado', () => {
        it('rechaza un sobre sin firma', async () => {
            const res = await fetch(`${a.http}/federate`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ toPubkey: 'pk', message: 'inyectado' })
            });
            expect(res.status).toBe(401);
        });

        it('rechaza un sobre firmado por un nodo DESCONOCIDO', async () => {
            const require = (await import('module')).createRequire(import.meta.url);
            const { signBody, newNonce } = require('../nodeIdentity');
            const crypto = require('crypto');
            const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
            const intruder = {
                pubkey: JSON.stringify(kp.publicKey.export({ format: 'jwk' })),
                privateJwk: kp.privateKey.export({ format: 'jwk' })
            };
            const body = {
                v: 1, op: 'deliver', from: intruder.pubkey, ts: Date.now(), nonce: newNonce(),
                toPubkey: 'pk-victima', fromPubkey: null, message: 'inyectado'
            };
            const res = await fetch(`${a.http}/federate`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ body, signature: signBody(intruder, body) })
            });
            expect(res.status).toBe(401);
            expect((await res.json()).error).toMatch(/desconocido/i);
        });

        it('rechaza el viejo token simétrico compartido', async () => {
            const res = await fetch(`${a.http}/federate`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-proxy-token': 'el-secreto-de-antes' },
                body: JSON.stringify({ toPubkey: 'pk', message: 'inyectado' })
            });
            expect(res.status).toBe(401);
        });
    });

    describe('ruteo por pubkey entre nodos', () => {
        it('un mensaje cruza del nodo B al nodo A', async () => {
            const alice = makeUser();
            const ca = await connectIdentified(a.url, alice);
            const cb = await connectTo(b.url);
            const payload = 'cruce-' + Date.now();
            cb.send({ to_publickey: alice.publickey, message: payload });
            const got = await ca.waitFor((m) => m.type === 'message' && m.message === payload);
            expect(got.message).toBe(payload);
            await ca.close(); await cb.close();
        });

        it('cruza en el otro sentido también', async () => {
            const bob = makeUser();
            const cb = await connectIdentified(b.url, bob);
            const ca = await connectTo(a.url);
            const payload = 'vuelta-' + Date.now();
            ca.send({ to_publickey: bob.publickey, message: payload });
            const got = await cb.waitFor((m) => m.type === 'message' && m.message === payload);
            expect(got.message).toBe(payload);
            await ca.close(); await cb.close();
        });

        it('con AMBOS extremos identificados, el receptor ve quién le escribe', async () => {
            const alice = makeUser();
            const bob = makeUser();
            const ca = await connectIdentified(a.url, alice);
            const cb = await connectIdentified(b.url, bob);
            const payload = 'con-remitente-' + Date.now();
            cb.send({ to_publickey: alice.publickey, message: payload });
            const got = await ca.waitFor((m) => m.type === 'message' && m.message === payload);
            expect(got.from_publickey).toBe(bob.publickey);
            await ca.close(); await cb.close();
        });

        it('el token corto NO cruza: escribirle a un token de otro nodo falla', async () => {
            // Este es exactamente el problema que quedan por resolver las fases 4-5.
            // El test lo deja documentado y fallará (avisando) cuando se arregle.
            const ca = await connectTo(a.url);
            const cb = await connectTo(b.url);
            cb.send({ to: [ca.token], message: 'por token', id: 'tok-1' });
            const res = await cb.waitFor((m) => m.type === 'message_sent' || m.type === 'error');
            expect(res.type).toBe('message_sent');
            expect(res.failed).toContain(ca.token);
            await ca.close(); await cb.close();
        });
    });
});
