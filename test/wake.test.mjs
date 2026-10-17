import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import http from 'http';
import crypto from 'crypto';
import { startNode, makeNodeDir, connectTo, connectIdentified, makeUser, freePort, sleep } from './fedHelpers.mjs';
import { makeDeviceKey, signWithDevice } from '@dotrino/identity/capabilities';
import { actaBody } from '@dotrino/identity/acta';

// DESPERTAR A UNA BÓVEDA QUE NO VIVE CONECTADA (la de una Lambda). Registra una URL con su
// llave de comunicación y el acta; si llega algo para su CUENTA y no hay nadie conectado, el
// proxio encola y llama a la URL. Al identificarse, la bóveda recibe lo encolado.
async function actaWith (master, comm) {
    const bodyObj = {
        v: 5, profileId: master.publickey, sealedBy: master.publickey, seq: 1,
        members: [
            { pub: master.publickey, caps: ['sign', 'read', 'store', 'sealer'] },
            { pub: comm.publickey, caps: ['sign'], cn: 'vault' }
        ],
        renounced: [], keyring: [], sealPub: null, sealSince: 0, sealKeys: [], updatedAt: Date.now()
    };
    const { signature } = await signWithDevice({ privateJwk: master.privateJwk, publickey: master.publickey, data: actaBody(bodyObj) });
    return { ...bodyObj, sig: signature };
}

function canonical(obj) {
    if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
    return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}
function signedChannel(name) {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = kp.publicKey.export({ format: 'jwk' });
    const data = { name, publickey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }) };
    const signature = crypto.sign('sha256', Buffer.from(canonical(data), 'utf8'), { key: kp.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
    return { data, signature };
}

describe('despertar a una bóveda', () => {
    let wakeServer, wakePort, node, dir;
    const hits = [];

    beforeAll(async () => {
        wakePort = await freePort();
        wakeServer = http.createServer((req, res) => {
            let b = ''; req.on('data', (c) => { b += c; });
            req.on('end', () => { hits.push({ url: req.url, body: b }); res.writeHead(202); res.end(); });
        });
        await new Promise((r) => wakeServer.listen(wakePort, '127.0.0.1', r));
        dir = makeNodeDir('despertar');
        node = await startNode({ name: 'SOLO', dir, port: await freePort() });
    }, 60000);

    afterAll(async () => {
        await node?.stop();
        wakeServer?.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    });

    const register = async (c, comm, acta, url, channel) => {
        const data = { op: 'push-subscribe', publickey: comm.publickey, ts: Date.now(), subscription: JSON.stringify({ kind: 'wake', url, ...(channel ? { channel } : {}) }) };
        c.send({ type: 'push-subscribe', data, signature: comm.sign(data), acta });
        return c.waitFor((m) => m.type === 'push-subscribed' || m.type === 'error');
    };

    it('llega algo para la cuenta, nadie conectado: se encola, se llama a la URL una vez, y al identificarse se entrega', async () => {
        const master = await makeDeviceKey();
        const comm = makeUser();
        const acta = await actaWith(master, comm);
        const url = `http://127.0.0.1:${wakePort}/wake?k=secreto`;

        const v = await connectIdentified(node.url, comm);
        const r = await register(v, comm, acta, url);
        expect(r.type).toBe('push-subscribed');
        expect(r.publickey).toBe(master.publickey);
        v.close();
        await sleep(200);

        const sender = await connectIdentified(node.url, makeUser());
        const before = hits.length;
        sender.send({ to_publickey: master.publickey, message: 'pedido-1', id: 'w1' });
        sender.send({ to_publickey: master.publickey, message: 'pedido-2', id: 'w2' });
        await sleep(700);
        const fresh = hits.slice(before);
        expect(fresh.length).toBe(1);
        expect(fresh[0].url).toBe('/wake?k=secreto');
        expect(JSON.parse(fresh[0].body).op).toBe('wake');

        // La bóveda arranca y se identifica CON EL ACTA: recibe lo que esperaba.
        const v2 = await connectTo(node.url);
        const received = [];
        v2.onMessage?.((m) => received.push(m));
        const data = { op: 'identify', publickey: comm.publickey, token: v2.token, ts: Date.now() };
        v2.send({ type: 'identify', data, signature: comm.sign(data), acta });
        const id = await v2.waitFor((m) => m.type === 'identified');
        expect(id.profile).toBe(master.publickey);
        expect(id.queued_delivered).toBe(2);
        v2.close();
        sender.close();
    }, 30000);

    it('con la bóveda conectada no se la despierta', async () => {
        const master = await makeDeviceKey();
        const comm = makeUser();
        const acta = await actaWith(master, comm);
        const v = await connectTo(node.url);
        const data = { op: 'identify', publickey: comm.publickey, token: v.token, ts: Date.now() };
        v.send({ type: 'identify', data, signature: comm.sign(data), acta });
        await v.waitFor((m) => m.type === 'identified');
        await register(v, comm, acta, `http://127.0.0.1:${wakePort}/viva`);
        const sender = await connectIdentified(node.url, makeUser());
        const before = hits.length;
        sender.send({ to_publickey: master.publickey, message: 'en-vivo', id: 'l1' });
        await sleep(500);
        expect(hits.slice(before).length).toBe(0);
        v.close(); sender.close();
    }, 30000);

    it('sin un acta que nombre la llave, no hay timbre', async () => {
        const master = await makeDeviceKey();
        const comm = makeUser();
        const other = makeUser();
        const acta = await actaWith(master, other);
        const v = await connectIdentified(node.url, comm);
        const r = await register(v, comm, acta, `http://127.0.0.1:${wakePort}/ajena`);
        expect(r.type).toBe('error');
        expect(r.code).toBe('not-a-member');
        v.close();
    }, 30000);

    it('listar el canal de la cuenta vacío la despierta y lo dice', async () => {
        const master = await makeDeviceKey();
        const comm = makeUser();
        const acta = await actaWith(master, comm);
        const chan = 'dotrino-vault-AB12-CD34-EF56';
        const v = await connectIdentified(node.url, comm);
        expect((await register(v, comm, acta, `http://127.0.0.1:${wakePort}/canal`, chan)).type).toBe('push-subscribed');
        v.close();
        await sleep(200);
        const who = await connectTo(node.url);
        const before = hits.length;
        who.send({ type: 'list', channel: signedChannel(chan), id: 'c1' });
        const r = await who.waitFor((m) => m.type === 'channel_list');
        expect(r.tokens).toEqual([]);
        expect(r.waking).toBe(true);
        await sleep(400);
        expect(hits.slice(before).map((h) => h.url)).toEqual(['/canal']);
        who.close();
    }, 30000);

    it('el registro sobrevive a reiniciar el proxio', async () => {
        const master = await makeDeviceKey();
        const comm = makeUser();
        const acta = await actaWith(master, comm);
        const v = await connectIdentified(node.url, comm);
        await register(v, comm, acta, `http://127.0.0.1:${wakePort}/persiste`);
        v.close();
        await node.stop();
        node = await startNode({ name: 'SOLO', dir, port: await freePort() });
        const sender = await connectIdentified(node.url, makeUser());
        const before = hits.length;
        sender.send({ to_publickey: master.publickey, message: 'tras-reinicio', id: 'p1' });
        await sleep(700);
        expect(hits.slice(before).map((h) => h.url)).toContain('/persiste');
        sender.close();
    }, 60000);
});
