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
            const telefono = makeUser();
            // Se suscribe y se desconecta: queda «apagado», que es cuando se encola y timbra.
            const ct = await connectIdentified(node.url, telefono);
            await subscribe(ct, telefono);
            await ct.close();

            const bóveda = await connectTo(node.url);
            let before = hits;
            bóveda.send({ to_publickey: telefono.publickey, message: 'aviso-vars', quiet: true, id: 'q1' });
            const r1 = await bóveda.waitFor((m) => m.type === 'message_sent' && m.id === 'q1');
            expect(r1.queued).toContain(telefono.publickey);
            expect(await hitsAfter(before)).toBe(0);

            before = hits;
            bóveda.send({ to_publickey: telefono.publickey, message: 'pedido', id: 'n1' });
            const r2 = await bóveda.waitFor((m) => m.type === 'message_sent' && m.id === 'n1');
            expect(r2.queued).toContain(telefono.publickey);
            expect(await hitsAfter(before)).toBeGreaterThan(0);

            // Callar no es descartar: al volver, el teléfono recibe los dos.
            const vuelve = await connectIdentified(node.url, telefono);
            const got = [];
            for (let i = 0; i < 2; i++) got.push((await vuelve.waitFor((m) => m.type === 'message' && !got.includes(m.message))).message);
            expect(got.sort()).toEqual(['aviso-vars', 'pedido']);
            await vuelve.close(); await bóveda.close();
        }, 30000);
    }
});
