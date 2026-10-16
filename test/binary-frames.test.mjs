import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import crypto from 'crypto';
import {
    startNode, makeNodeDir, connectTo, connectIdentified, makeUser, freePort, waitForMesh
} from './fedHelpers.mjs';

// Binary frames (1.6.0): a message with files arrives as [header JSON][raw body] and leaves
// the same way, on every path: by token, by pubkey, from the offline queue and across nodes.
describe('binary frames', () => {
    let a, b, dirA, dirB;

    beforeAll(async () => {
        dirA = makeNodeDir('bin-a');
        dirB = makeNodeDir('bin-b');
        const [portA, portB] = [await freePort(), await freePort()];
        [a, b] = await Promise.all([
            startNode({ name: 'A', dir: dirA, port: portA, peers: [`http://127.0.0.1:${portB}`] }),
            startNode({ name: 'B', dir: dirB, port: portB, peers: [`http://127.0.0.1:${portA}`] })
        ]);
        await waitForMesh([a, b]);
    }, 60000);

    afterAll(async () => {
        await Promise.all([a?.stop(), b?.stop()]);
        for (const d of [dirA, dirB]) fs.rmSync(d, { recursive: true, force: true });
    });

    const bytes = (n) => crypto.randomBytes(n);

    it('announces the binary capability', async () => {
        const c = await connectTo(a.url);
        expect(c.recv.find((m) => m.type === 'connected').caps).toContain('binary');
        await c.close();
    });

    it('by token, the body arrives as the same bytes in a binary frame', async () => {
        const [x, y] = [await connectTo(a.url), await connectTo(a.url)];
        const data = bytes(600 * 1024);
        x.sendBinary({ to: [y.token] }, data);
        const got = await y.waitFor((m) => m.type === 'message' && m.binary);
        expect(got.from).toBe(x.token);
        expect(Buffer.compare(got.message, data)).toBe(0);
        await Promise.all([x.close(), y.close()]);
    });

    it('text messages are still text', async () => {
        const [x, y] = [await connectTo(a.url), await connectTo(a.url)];
        x.send({ to: [y.token], message: '{"hello":1}' });
        const got = await y.waitFor((m) => m.type === 'message');
        expect(got.binary).toBeUndefined();
        expect(got.message).toBe('{"hello":1}');
        await Promise.all([x.close(), y.close()]);
    });

    it('a malformed binary frame is answered with bad-frame', async () => {
        const x = await connectTo(a.url);
        x.ws.send(Buffer.from([9, 1, 2, 3, 4, 5]), { binary: true });
        const e = await x.waitFor((m) => m.type === 'error');
        expect(e.code).toBe('bad-frame');
        await x.close();
    });

    // 900 KB: in base64 it would not fit the 1 MB frame of the other node, which closed the
    // mesh link on every reconnect and left everything behind it stuck (1.6.0, fixed in 1.6.1).
    it('to an instance of the OTHER node, through the mesh, raw and close to the frame limit', async () => {
        const x = await connectTo(a.url);
        const y = await connectTo(b.url);
        const data = bytes(900 * 1024);
        x.sendBinary({ to: [y.token] }, data);
        const got = await y.waitFor((m) => m.type === 'message' && m.binary);
        expect(Buffer.compare(got.message, data)).toBe(0);
        // The link is still up: a text message right after it arrives too.
        x.send({ to: [y.token], message: '{"after":1}' });
        const after = await y.waitFor((m) => m.type === 'message' && m.message === '{"after":1}');
        expect(after.from).toBe(x.token);
        const peers = await fetch(`${a.http}/peers`).then((r) => r.json());
        expect(Object.values(peers.mesh).every((l) => l.ready && !l.tooBig)).toBe(true);
        await Promise.all([x.close(), y.close()]);
    });

    it('by pubkey to someone offline: it waits in the queue and comes out as bytes', async () => {
        const alice = makeUser();
        const bob = makeUser();
        const x = await connectIdentified(a.url, alice);
        const data = bytes(200 * 1024);
        x.sendBinary({ to_publickey: [bob.publickey] }, data);
        await x.waitFor((m) => m.type === 'message_sent' && m.queued?.length === 1);
        const y = await connectIdentified(a.url, bob);
        const got = await y.waitFor((m) => m.type === 'message' && m.queued);
        expect(got.binary).toBe(true);
        expect(got.from_publickey).toBe(alice.publickey);
        expect(Buffer.compare(got.message, data)).toBe(0);
        await Promise.all([x.close(), y.close()]);
    });

    it('by pubkey to someone connected to the OTHER node', async () => {
        const alice = makeUser();
        const bob = makeUser();
        const y = await connectIdentified(b.url, bob);
        const x = await connectIdentified(a.url, alice);
        const data = bytes(900 * 1024);
        x.sendBinary({ to_publickey: [bob.publickey] }, data);
        const got = await y.waitFor((m) => m.type === 'message' && m.binary);
        expect(Buffer.compare(got.message, data)).toBe(0);
        await Promise.all([x.close(), y.close()]);
    });
});
