import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import http from 'http';
import crypto from 'crypto';
import {
    startNode, makeNodeDir, connectTo, connectIdentified, makeUser, freePort, sleep
} from './fedHelpers.mjs';

// Mensajes CALLADOS: se encolan igual que cualquiera, pero NO tocan el timbre push.
// Existen porque la bóveda avisa a todos los miembros de cada cambio del perfil, y cada
// aviso hacía sonar el teléfono con «alguien pide tus claves» sin que hubiera ningún
// pedido. Un timbre que no trae nada que hacer enseña a ignorar el siguiente.
//
// Cómo se ve el timbre sin FCM de verdad: la cuenta de servicio apunta su `token_uri` a
// un servidor local que contesta 500. Cada timbre FCM empieza pidiendo ese token, así que
// cada petición que llega ahí es un timbre, y al fallar no queda nada en caché.
describe('envío callado (quiet)', () => {
    let tokenServer, hits = 0;
    const nodes = [];
    const dirs = [];

    const serviceAccount = (port) => {
        const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const sa = {
            client_email: 'test@example.iam.gserviceaccount.com',
            private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
            project_id: 'test',
            token_uri: `http://127.0.0.1:${port}/token`
        };
        return Buffer.from(JSON.stringify(sa)).toString('base64');
    };

    const subscribe = async (c, user) => {
        const data = {
            op: 'push-subscribe', publickey: user.publickey, ts: Date.now(),
            subscription: JSON.stringify({ kind: 'fcm', token: 'fcm-token-de-prueba-0123456789' })
        };
        c.send({ type: 'push-subscribe', data, signature: user.sign(data) });
        const r = await c.waitFor((m) => m.type === 'push-subscribed' || m.type === 'error');
        expect(r.type).toBe('push-subscribed');
    };

    // Espera un poco a que el timbre (asíncrono) llegue, o a que quede claro que no llega.
    const hitsAfter = async (before, ms = 800) => { await sleep(ms); return hits - before; };

    beforeAll(async () => {
        const tport = await freePort();
        tokenServer = http.createServer((req, res) => { hits++; res.writeHead(500); res.end(); });
        await new Promise((r) => tokenServer.listen(tport, '127.0.0.1', r));
        const env = { FCM_SERVICE_ACCOUNT_B64: serviceAccount(tport) };

        // Uno solo (cola local) y un par federado (el otro camino que encola y timbra).
        const [pSolo, pA, pB] = await Promise.all([freePort(), freePort(), freePort()]);
        for (const n of ['quiet-solo', 'quiet-a', 'quiet-b']) dirs.push(makeNodeDir(n));
        nodes.push(...await Promise.all([
            startNode({ name: 'SOLO', dir: dirs[0], port: pSolo, env }),
            startNode({ name: 'A', dir: dirs[1], port: pA, peers: [`http://127.0.0.1:${pB}`], env }),
            startNode({ name: 'B', dir: dirs[2], port: pB, peers: [`http://127.0.0.1:${pA}`], env })
        ]));
    }, 60000);

    afterAll(async () => {
        await Promise.all(nodes.map((n) => n?.stop()));
        tokenServer?.close();
        for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
    });

    for (const [caso, idx] of [['sin federación', 0], ['con federación', 1]]) {
        it(`${caso}: callado se encola sin timbrar; normal timbra`, async () => {
            const node = nodes[idx];
            const phone = makeUser();
            // Se suscribe y se desconecta: queda «apagado», que es cuando se encola y timbra.
            const ct = await connectIdentified(node.url, phone);
            await subscribe(ct, phone);
            await ct.close();

            const vault = await connectTo(node.url);
            let before = hits;
            vault.send({ to_publickey: phone.publickey, message: 'aviso-vars', quiet: true, id: 'q1' });
            const r1 = await vault.waitFor((m) => m.type === 'message_sent' && m.id === 'q1');
            expect(r1.queued).toContain(phone.publickey);
            expect(await hitsAfter(before)).toBe(0);

            before = hits;
            vault.send({ to_publickey: phone.publickey, message: 'pedido', id: 'n1' });
            const r2 = await vault.waitFor((m) => m.type === 'message_sent' && m.id === 'n1');
            expect(r2.queued).toContain(phone.publickey);
            expect(await hitsAfter(before)).toBeGreaterThan(0);

            // Callar no es descartar: al volver, el teléfono recibe los dos.
            const returns = await connectIdentified(node.url, phone);
            const got = [];
            for (let i = 0; i < 2; i++) got.push((await returns.waitFor((m) => m.type === 'message' && !got.includes(m.message))).message);
            expect(got.sort()).toEqual(['aviso-vars', 'pedido']);
            await returns.close(); await vault.close();
        }, 30000);
    }
    // EN VIVO TAMBIÉN TIMBRA: la conexión que el proxio cree viva puede estar muerta (un
    // teléfono en segundo plano), y lo que se le entrega ahí no lo ve nadie. La app decide
    // qué hace con el timbre; el proxio no adivina si «está».
    for (const [caso, idx] of [['sin federación', 0], ['con federación', 1]]) {
        it(`${caso}: entregado en vivo timbra igual; callado y efímero no`, async () => {
            const node = nodes[idx];
            const phone = makeUser();
            const ct = await connectIdentified(node.url, phone);
            await subscribe(ct, phone);
            const vault = await connectTo(node.url);

            let before = hits;
            vault.send({ to_publickey: phone.publickey, message: 'pedido', id: 'v1' });
            await ct.waitFor((m) => m.type === 'message' && m.message === 'pedido');
            expect(await hitsAfter(before)).toBeGreaterThan(0);

            before = hits;
            vault.send({ to_publickey: phone.publickey, message: 'callado', quiet: true, id: 'v2' });
            await ct.waitFor((m) => m.type === 'message' && m.message === 'callado');
            expect(await hitsAfter(before)).toBe(0);

            before = hits;
            vault.send({ to_publickey: phone.publickey, message: 'jugada', ephemeral: true, id: 'v3' });
            await ct.waitFor((m) => m.type === 'message' && m.message === 'jugada');
            expect(await hitsAfter(before)).toBe(0);
            await ct.close(); await vault.close();
        }, 30000);
    }
});
