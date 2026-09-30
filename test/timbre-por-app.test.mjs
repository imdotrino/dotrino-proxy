import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import { createRequire } from 'module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
import { startNode, makeNodeDir, connectTo, connectIdentified, makeUser, freePort, sleep } from './fedHelpers.mjs';

// EL TIMBRE ES DIRIGIDO A UNA APP (dueño, 2026-09-30). En un teléfono varias apps comparten
// la llave del perfil: con una suscripción por llave, la última en registrarse se llevaba
// todos los timbres (messenger sonaba con los pedidos de la bóveda) y la primera en
// conectarse vaciaba la cola de todas.
//
// Cómo se ve qué app timbró: cada una se suscribe con un Web Push cuyo endpoint es una ruta
// de un servidor local; cada POST que llega a `/<app>` es un timbre a esa app. Es HTTPS con un
// certificado propio porque `web-push` solo habla HTTPS (el nodo de prueba lo acepta).
describe('timbre y cola por app', () => {
    let pushServer, pushPort;
    const hits = [];
    let node, dir;

    const webSub = (path) => {
        const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
        return {
            endpoint: `https://127.0.0.1:${pushPort}/${path}`,
            keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') }
        };
    };
    const subscribe = async (c, user, app, path = app || 'todas') => {
        const data = { op: 'push-subscribe', publickey: user.publickey, ts: Date.now(), subscription: JSON.stringify(webSub(path)), ...(app ? { app } : {}) };
        c.send({ type: 'push-subscribe', data, signature: user.sign(data) });
        const r = await c.waitFor((m) => m.type === 'push-subscribed' || m.type === 'error');
        expect(r.type).toBe('push-subscribed');
    };
    const rungSince = async (i, ms = 700) => { await sleep(ms); return hits.slice(i).sort(); };

    beforeAll(async () => {
        pushPort = await freePort();
        const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-cert-'));
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
            '-keyout', path.join(certDir, 'k.pem'), '-out', path.join(certDir, 'c.pem')], { stdio: 'ignore' });
        pushServer = https.createServer({ key: fs.readFileSync(path.join(certDir, 'k.pem')), cert: fs.readFileSync(path.join(certDir, 'c.pem')) },
            (req, res) => { hits.push(req.url.slice(1)); req.resume(); res.writeHead(201); res.end(); });
        await new Promise((r) => pushServer.listen(pushPort, '127.0.0.1', r));
        dir = makeNodeDir('timbre-app');
        node = await startNode({ name: 'SOLO', dir, port: await freePort(), env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
    }, 60000);

    afterAll(async () => {
        await node?.stop();
        pushServer?.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    });

    it('dos apps con la misma llave: cada una recibe SOLO su timbre, y la última no pisa a la otra', async () => {
        const tel = makeUser();
        const c = await connectIdentified(node.url, tel);
        await subscribe(c, tel, 'vault');
        await subscribe(c, tel, 'messenger');
        await c.close();

        const emisor = await connectTo(node.url);
        let i = hits.length;
        emisor.send({ to_publickey: tel.publickey, message: 'pedido', app: 'vault', id: 'a1' });
        await emisor.waitFor((m) => m.type === 'message_sent' && m.id === 'a1');
        expect(await rungSince(i)).toEqual(['vault']);

        i = hits.length;
        emisor.send({ to_publickey: tel.publickey, message: 'hola', app: 'messenger', id: 'a2' });
        await emisor.waitFor((m) => m.type === 'message_sent' && m.id === 'a2');
        expect(await rungSince(i)).toEqual(['messenger']);

        // Sin app (un emisor que aún no lo dice): a todas, como antes.
        i = hits.length;
        emisor.send({ to_publickey: tel.publickey, message: 'sin-app', id: 'a3' });
        await emisor.waitFor((m) => m.type === 'message_sent' && m.id === 'a3');
        expect(await rungSince(i)).toEqual(['messenger', 'vault']);

        // Cada app baja lo suyo (y lo que no dijo a quién iba); lo de la otra se queda.
        const msgr = await connectIdentified(node.url, tel, { app: 'messenger' });
        const got = [];
        for (let k = 0; k < 2; k++) got.push((await msgr.waitFor((m) => m.type === 'message' && !got.includes(m.message))).message);
        expect(got.sort()).toEqual(['hola', 'sin-app']);
        await sleep(300);

        // Con messenger CONECTADO, lo de la bóveda no se le entrega a messenger: se encola y timbra a la bóveda.
        i = hits.length;
        emisor.send({ to_publickey: tel.publickey, message: 'pedido-2', app: 'vault', id: 'a4' });
        const r4 = await emisor.waitFor((m) => m.type === 'message_sent' && m.id === 'a4');
        expect(r4.queued).toContain(tel.publickey);
        expect(await rungSince(i)).toEqual(['vault']);

        const vault = await connectIdentified(node.url, tel, { app: 'vault' });
        const got2 = [];
        for (let k = 0; k < 2; k++) got2.push((await vault.waitFor((m) => m.type === 'message' && !got2.includes(m.message))).message);
        expect(got2.sort()).toEqual(['pedido', 'pedido-2']);
        await msgr.close(); await vault.close(); await emisor.close();
    }, 30000);

    it('una suscripción que no dice su app (cliente viejo) recibe todos los timbres', async () => {
        const tel = makeUser();
        const c = await connectIdentified(node.url, tel);
        await subscribe(c, tel, null, 'vieja');
        await c.close();
        const emisor = await connectTo(node.url);
        const i = hits.length;
        emisor.send({ to_publickey: tel.publickey, message: 'x', app: 'messenger', id: 'b1' });
        await emisor.waitFor((m) => m.type === 'message_sent' && m.id === 'b1');
        expect(await rungSince(i)).toEqual(['vieja']);
        await emisor.close();
    }, 30000);

    it('una app que antes no decía cuál era y ahora sí: su fila vieja se va (si no, seguiría sonando con todo)', async () => {
        const tel = makeUser();
        const c = await connectIdentified(node.url, tel);
        const sub = webSub('msgr-token');
        const reg = async (app) => {
            const data = { op: 'push-subscribe', publickey: tel.publickey, ts: Date.now(), subscription: JSON.stringify(sub), ...(app ? { app } : {}) };
            c.send({ type: 'push-subscribe', data, signature: tel.sign(data) });
            await c.waitFor((m) => m.type === 'push-subscribed' && (m.app || null) === (app || null));
        };
        await reg(null);          // messenger viejo: sin app
        await reg('messenger');   // messenger nuevo: el MISMO token, ahora con app
        await subscribe(c, tel, 'vault');
        await c.close();
        const emisor = await connectTo(node.url);
        const i = hits.length;
        emisor.send({ to_publickey: tel.publickey, message: 'pedido', app: 'vault', id: 'r1' });
        await emisor.waitFor((m) => m.type === 'message_sent' && m.id === 'r1');
        expect(await rungSince(i)).toEqual(['vault']);
        await emisor.close();
    }, 30000);

    it('una base con el esquema VIEJO se migra: la suscripción sigue y la cola también', async () => {
        // Es lo que pasa en proxy1/proxy2 al desplegar: la base existe, sin columna `app`.
        const tel = makeUser();
        const oldDir = makeNodeDir('timbre-migra');
        const db = new DatabaseSync(path.join(oldDir, 'proxy.db'));
        db.exec(`
            CREATE TABLE push_subscriptions (pubkey TEXT PRIMARY KEY, subscription TEXT NOT NULL, updated_at INTEGER NOT NULL);
            CREATE TABLE offline_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, pubkey TEXT NOT NULL, from_token TEXT, from_pubkey TEXT,
                message TEXT NOT NULL, queued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, bytes INTEGER NOT NULL);
        `);
        db.prepare('INSERT INTO push_subscriptions VALUES (?, ?, ?)').run(tel.publickey, JSON.stringify(webSub('migrada')), Date.now());
        db.prepare('INSERT INTO offline_queue (pubkey, message, queued_at, expires_at, bytes) VALUES (?, ?, ?, ?, ?)')
            .run(tel.publickey, JSON.stringify('de-antes'), Date.now(), Date.now() + 3600e3, 10);
        db.close();
        const viejo = await startNode({ name: 'MIGRA', dir: oldDir, port: await freePort(), env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
        try {
            const emisor = await connectTo(viejo.url);
            const i = hits.length;
            emisor.send({ to_publickey: tel.publickey, message: 'nuevo', app: 'vault', id: 'm1' });
            await emisor.waitFor((m) => m.type === 'message_sent' && m.id === 'm1');
            expect(await rungSince(i)).toEqual(['migrada']);
            const c = await connectIdentified(viejo.url, tel, { app: 'vault' });
            const got = [];
            for (let k = 0; k < 2; k++) got.push((await c.waitFor((m) => m.type === 'message' && !got.includes(m.message))).message);
            expect(got.sort()).toEqual(['de-antes', 'nuevo']);
            await c.close(); await emisor.close();
        } finally {
            await viejo.stop();
            try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch (_) {}
        }
    }, 30000);
});
