import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import {
    startNode, makeNodeDir, connectTo, connectIdentified, makeUser, freePort, sleep
} from './fedHelpers.mjs';

// Los mensajes EN TRÁNSITO viven en el dotrino-content de la cuenta del proxio
// (PROXY_CONTENT_URL), no en su SQLite. El node se imita con un servidor HTTP que habla
// lo mismo que el de verdad (`/stats` con `owner`, `POST /c`, `GET|DELETE /c/<cid>`).

/** La huella de una llave, igual que `pubkeyId` de @dotrino/identity. */
const pubkeyId = (jwkStr) => {
    const j = JSON.parse(jwkStr);
    return crypto.createHash('sha256').update(JSON.stringify({ crv: j.crv, kty: j.kty, x: j.x, y: j.y })).digest('hex');
};

/** Una cuenta: la llave con la que el proxio dice haberse enrolado (`iss`). */
const makeAccount = () => {
    const jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
    const iss = JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });
    return { iss, owner: pubkeyId(iss) };
};

/** Pone la `iss` de la cuenta en la identidad de servicio del nodo. */
const enrollTo = (dir, account) => {
    const f = path.join(dir, 'vault-service', 'service-identity.json');
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(f, JSON.stringify({ ...rec, iss: account.iss }));
};

function fakeContentNode(owner) {
    const blobs = new Map();
    const log = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const [, top, cid] = url.pathname.split('/');
        log.push(`${req.method} /${top}${cid ? '/' + cid : ''}${url.search}`);
        if (req.method === 'GET' && top === 'stats') {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ blobs: blobs.size, owner }));
        }
        if (req.method === 'POST' && top === 'c' && !cid) {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const bytes = Buffer.concat(chunks);
                const id = 'sha256-' + crypto.createHash('sha256').update(bytes).digest('hex');
                blobs.set(id, { bytes, enc: url.searchParams.get('enc'), ttl: Number(url.searchParams.get('ttl')) });
                res.writeHead(201, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ cid: id, size: bytes.length, existed: false }));
            });
            return;
        }
        if (top === 'c' && cid) {
            const b = blobs.get(cid);
            if (!b) { res.writeHead(404); return res.end(); }
            if (req.method === 'DELETE') { blobs.delete(cid); res.writeHead(200); return res.end('{}'); }
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            return res.end(b.bytes);
        }
        res.writeHead(404); res.end();
    });
    return { server, blobs, log };
}

const listen = async (server) => {
    const port = await freePort();
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    return `http://127.0.0.1:${port}`;
};

const waitUntil = async (fn, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await sleep(80); }
    return false;
};

describe('cola offline en el content de la cuenta', () => {
    const account = makeAccount();
    const content = fakeContentNode(account.owner);
    const otherContent = fakeContentNode(makeAccount().owner);
    let node, foreign;
    const dirs = [];

    beforeAll(async () => {
        const [url, otherUrl] = [await listen(content.server), await listen(otherContent.server)];
        for (const n of ['cq-mine', 'cq-foreign']) { const d = makeNodeDir(n); enrollTo(d, account); dirs.push(d); }
        node = await startNode({ name: 'MINE', dir: dirs[0], env: { PROXY_CONTENT_URL: url } });
        foreign = await startNode({ name: 'FOREIGN', dir: dirs[1], env: { PROXY_CONTENT_URL: otherUrl } });
        await waitUntil(async () => (await fetch(`${node.http}/health`).then((r) => r.json())).queue === 'content');
    }, 30000);

    afterAll(async () => {
        await Promise.all([node?.stop(), foreign?.stop()]);
        content.server.close(); otherContent.server.close();
        for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    });

    it('/health dice dónde guarda los mensajes en tránsito', async () => {
        expect((await fetch(`${node.http}/health`).then((r) => r.json())).queue).toBe('content');
        expect((await fetch(`${foreign.http}/health`).then((r) => r.json())).queue).toBe('content-unavailable');
    });

    it('el cuerpo va al content, vuelve entero al destinatario y se borra al entregarse', async () => {
        const alice = makeUser();
        const bob = makeUser();
        const a = await connectIdentified(node.url, alice);
        // Dos mensajes de ~600 KB: con la cola en SQLite (1 MB por destinatario) el primero
        // se habría descartado para que cupiera el segundo.
        const big = (n) => ({ sealed: true, n, blob: crypto.randomBytes(450 * 1024).toString('base64') });
        const msgs = [big(1), big(2)];
        for (const m of msgs) a.send({ to_publickey: [bob.publickey], message: m });
        await a.waitFor((m) => m.type === 'message_sent' && m.queued?.length === 1);
        expect(await waitUntil(() => content.blobs.size === 2)).toBe(true);
        for (const b of content.blobs.values()) {
            expect(b.enc).toBe('1');
            expect(b.ttl).toBeGreaterThan(23 * 3600 * 1000);
            // Lo que guarda el node lleva al destinatario dentro: dos mensajes iguales a
            // dos personas no comparten cid.
            expect(JSON.parse(b.bytes.toString()).to).toBe(bob.publickey);
        }

        const b = await connectIdentified(node.url, bob);
        const got = b.recv.filter((m) => m.type === 'message' && m.queued);
        expect(got.map((m) => m.message.n)).toEqual([1, 2]);
        expect(got[1].message.blob).toBe(msgs[1].blob);
        expect(await waitUntil(() => content.blobs.size === 0)).toBe(true);
        await Promise.all([a.close(), b.close()]);
    });

    it('con un node de OTRA cuenta no encola, y se lo dice a quien manda', async () => {
        const alice = makeUser();
        const bob = makeUser();
        const a = await connectIdentified(foreign.url, alice);
        a.send({ to_publickey: [bob.publickey], message: { sealed: true, hola: 1 } });
        const r = await a.waitFor((m) => m.type === 'message_sent');
        expect(r.failed).toEqual([bob.publickey]);
        expect(r.code).toBe('queue-unavailable');
        expect(otherContent.log.some((l) => l.startsWith('POST /c'))).toBe(false);
        await a.close();
    });
});
