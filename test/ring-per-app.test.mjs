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
        node = await startNode({ name: 'SOLO', dir, port: await freePort(), env: { NODE_TLS_REJECT_UNAUTHORIZED: '0', SCHED_TICK_MS: '200' } });
    }, 60000);

    afterAll(async () => {
        await node?.stop();
        pushServer?.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    });

    it('dos apps con la misma llave: cada una recibe SOLO su timbre, y la última no pisa a la otra', async () => {
        const phone = makeUser();
        const c = await connectIdentified(node.url, phone);
        await subscribe(c, phone, 'vault');
        await subscribe(c, phone, 'messenger');
        await c.close();

        const sender = await connectTo(node.url);
        let i = hits.length;
        sender.send({ to_publickey: phone.publickey, message: 'pedido', app: 'vault', id: 'a1' });
        await sender.waitFor((m) => m.type === 'message_sent' && m.id === 'a1');
        expect(await rungSince(i)).toEqual(['vault']);

        i = hits.length;
        sender.send({ to_publickey: phone.publickey, message: 'hola', app: 'messenger', id: 'a2' });
        await sender.waitFor((m) => m.type === 'message_sent' && m.id === 'a2');
        expect(await rungSince(i)).toEqual(['messenger']);

        // Sin app (un emisor que aún no lo dice): a todas, como antes.
        i = hits.length;
        sender.send({ to_publickey: phone.publickey, message: 'sin-app', id: 'a3' });
        await sender.waitFor((m) => m.type === 'message_sent' && m.id === 'a3');
        expect(await rungSince(i)).toEqual(['messenger', 'vault']);

        // Cada app baja lo suyo (y lo que no dijo a quién iba); lo de la otra se queda.
        const msgr = await connectIdentified(node.url, phone, { app: 'messenger' });
        const got = [];
        for (let k = 0; k < 2; k++) got.push((await msgr.waitFor((m) => m.type === 'message' && !got.includes(m.message))).message);
        expect(got.sort()).toEqual(['hola', 'sin-app']);
        await sleep(300);

        // Con messenger CONECTADO, lo de la bóveda no se le entrega a messenger: se encola y timbra a la bóveda.
        i = hits.length;
        sender.send({ to_publickey: phone.publickey, message: 'pedido-2', app: 'vault', id: 'a4' });
        const r4 = await sender.waitFor((m) => m.type === 'message_sent' && m.id === 'a4');
        expect(r4.queued).toContain(phone.publickey);
        expect(await rungSince(i)).toEqual(['vault']);

        const vault = await connectIdentified(node.url, phone, { app: 'vault' });
        const got2 = [];
        for (let k = 0; k < 2; k++) got2.push((await vault.waitFor((m) => m.type === 'message' && !got2.includes(m.message))).message);
        expect(got2.sort()).toEqual(['pedido', 'pedido-2']);
        await msgr.close(); await vault.close(); await sender.close();
    }, 30000);

    it('una suscripción que no dice su app (cliente viejo) recibe todos los timbres', async () => {
        const phone = makeUser();
        const c = await connectIdentified(node.url, phone);
        await subscribe(c, phone, null, 'vieja');
        await c.close();
        const sender = await connectTo(node.url);
        const i = hits.length;
        sender.send({ to_publickey: phone.publickey, message: 'x', app: 'messenger', id: 'b1' });
        await sender.waitFor((m) => m.type === 'message_sent' && m.id === 'b1');
        expect(await rungSince(i)).toEqual(['vieja']);
        await sender.close();
    }, 30000);

    it('una app que antes no decía cuál era y ahora sí: su fila vieja se va (si no, seguiría sonando con todo)', async () => {
        const phone = makeUser();
        const c = await connectIdentified(node.url, phone);
        const sub = webSub('msgr-token');
        const reg = async (app) => {
            const data = { op: 'push-subscribe', publickey: phone.publickey, ts: Date.now(), subscription: JSON.stringify(sub), ...(app ? { app } : {}) };
            c.send({ type: 'push-subscribe', data, signature: phone.sign(data) });
            await c.waitFor((m) => m.type === 'push-subscribed' && (m.app || null) === (app || null));
        };
        await reg(null);          // messenger viejo: sin app
        await reg('messenger');   // messenger nuevo: el MISMO token, ahora con app
        await subscribe(c, phone, 'vault');
        await c.close();
        const sender = await connectTo(node.url);
        const i = hits.length;
        sender.send({ to_publickey: phone.publickey, message: 'pedido', app: 'vault', id: 'r1' });
        await sender.waitFor((m) => m.type === 'message_sent' && m.id === 'r1');
        expect(await rungSince(i)).toEqual(['vault']);
        await sender.close();
    }, 30000);

    it('un recordatorio programado suena en la app que lo programó (y uno sin app, en todas)', async () => {
        const phone = makeUser();
        const c = await connectIdentified(node.url, phone);
        await subscribe(c, phone, 'messenger', 'sched-messenger');
        await subscribe(c, phone, 'expenses', 'sched-expenses');
        const schedule = async (app) => {
            const spec = JSON.stringify({ fireAt: Date.now() + 400, payload: { title: 'Expenses' } });
            const data = { op: 'schedule-push', publickey: phone.publickey, spec, ts: Date.now(), ...(app ? { app } : {}) };
            c.send({ type: 'schedule-push', data, signature: phone.sign(data) });
            const r = await c.waitFor((m) => m.type === 'push-scheduled' || m.type === 'error');
            expect(r.type).toBe('push-scheduled');
        };
        let i = hits.length;
        await schedule('expenses');
        expect(await rungSince(i, 1500)).toEqual(['sched-expenses']);
        i = hits.length;
        await schedule(null);
        expect(await rungSince(i, 1500)).toEqual(['sched-expenses', 'sched-messenger']);
        await c.close();
    }, 30000);

    it('push-prune: el receptor dice qué llaves le quedan y deja de sonar con las demás', async () => {
        // El teléfono quitó una cuenta: ya no tiene su llave, así que no puede firmar la baja.
        const remains = makeUser(); const deleted = makeUser(); const foreign = makeUser(); const fromOtherApp = makeUser();
        const c = await connectTo(node.url);
        const sub = webSub('telefono');
        const reg = async (user, app, s = sub) => {
            const data = { op: 'push-subscribe', publickey: user.publickey, ts: Date.now(), subscription: JSON.stringify(s), app };
            c.send({ type: 'push-subscribe', data, signature: user.sign(data) });
            expect((await c.waitFor((m) => (m.type === 'push-subscribed' && m.publickey === user.publickey && m.app === app) || m.type === 'error')).type).toBe('push-subscribed');
        };
        await reg(remains, 'vault'); await reg(deleted, 'vault'); await reg(fromOtherApp, 'messenger');
        await reg(foreign, 'vault', webSub('otro-telefono'));
        const rings = async (user, app, id) => {
            const i = hits.length;
            c.send({ to_publickey: user.publickey, message: id, app, id });
            await c.waitFor((m) => m.type === 'message_sent' && m.id === id);
            return rungSince(i);
        };
        expect(await rings(deleted, 'vault', 'p0')).toEqual(['telefono']);

        c.send({ type: 'push-prune', target: sub.endpoint, app: 'vault', keep: [remains.publickey], id: 'pr' });
        const r = await c.waitFor((m) => m.id === 'pr');
        expect(r.type).toBe('push-pruned');
        expect(r.removed).toBe(1);

        expect(await rings(deleted, 'vault', 'p1')).toEqual([]);                 // la borrada ya no suena
        expect(await rings(remains, 'vault', 'p2')).toEqual(['telefono']);         // la que queda, sí
        expect(await rings(fromOtherApp, 'messenger', 'p3')).toEqual(['telefono']); // otra app: no se toca
        expect(await rings(foreign, 'vault', 'p4')).toEqual(['otro-telefono']);    // otro receptor: tampoco

        // Mal formado: se dice, no se quita nada.
        c.send({ type: 'push-prune', target: sub.endpoint, id: 'bad' });
        expect((await c.waitFor((m) => m.id === 'bad')).code).toBe('bad-format');
        await c.close();
    }, 30000);

    it('una base con el esquema VIEJO se migra: la suscripción sigue y la cola también', async () => {
        // Es lo que pasa en proxy1/proxy2 al desplegar: la base existe, sin columna `app`.
        const phone = makeUser();
        const oldDir = makeNodeDir('timbre-migra');
        const db = new DatabaseSync(path.join(oldDir, 'proxy.db'));
        db.exec(`
            CREATE TABLE push_subscriptions (pubkey TEXT PRIMARY KEY, subscription TEXT NOT NULL, updated_at INTEGER NOT NULL);
            CREATE TABLE offline_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, pubkey TEXT NOT NULL, from_token TEXT, from_pubkey TEXT,
                message TEXT NOT NULL, queued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, bytes INTEGER NOT NULL);
        `);
        db.prepare('INSERT INTO push_subscriptions VALUES (?, ?, ?)').run(phone.publickey, JSON.stringify(webSub('migrada')), Date.now());
        db.prepare('INSERT INTO offline_queue (pubkey, message, queued_at, expires_at, bytes) VALUES (?, ?, ?, ?, ?)')
            .run(phone.publickey, JSON.stringify('de-antes'), Date.now(), Date.now() + 3600e3, 10);
        db.close();
        const old = await startNode({ name: 'MIGRA', dir: oldDir, port: await freePort(), env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
        try {
            const sender = await connectTo(old.url);
            const i = hits.length;
            sender.send({ to_publickey: phone.publickey, message: 'nuevo', app: 'vault', id: 'm1' });
            await sender.waitFor((m) => m.type === 'message_sent' && m.id === 'm1');
            expect(await rungSince(i)).toEqual(['migrada']);
            const c = await connectIdentified(old.url, phone, { app: 'vault' });
            const got = [];
            for (let k = 0; k < 2; k++) got.push((await c.waitFor((m) => m.type === 'message' && !got.includes(m.message))).message);
            expect(got.sort()).toEqual(['de-antes', 'nuevo']);
            await c.close(); await sender.close();
        } finally {
            await old.stop();
            try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch (_) {}
        }
    }, 30000);
});
