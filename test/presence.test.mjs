import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
    startTestServer,
    stopTestServer,
    connectClient,
    makeMockChannel,
    sleep
} from './helpers.mjs';

describe('presence: joined / left / disconnected', () => {
    let url;
    const clients = [];

    beforeAll(async () => {
        ({ url } = await startTestServer());
    });

    afterAll(async () => {
        await stopTestServer();
    });

    afterEach(async () => {
        while (clients.length) {
            const c = clients.pop();
            try { await c.close(); } catch (_) { /* noop */ }
        }
    });

    async function connect() {
        const c = await connectClient(url);
        clients.push(c);
        return c;
    }

    async function publish(client, channelName) {
        client.send({ type: 'publish', channel: makeMockChannel(channelName) });
        await client.waitFor((m) => m.type === 'published', { fromNow: true });
    }

    describe('joined', () => {
        it('avisa a los miembros existentes cuando alguien publica', async () => {
            const a = await connect();
            const b = await connect();
            await publish(a, 'p-join');

            await publish(b, 'p-join');

            const evt = await a.waitFor((m) => m.type === 'joined');
            expect(evt).toMatchObject({
                type: 'joined',
                token: b.token,
                channel: 'p-join'
            });
            expect(evt.timestamp).toEqual(expect.any(String));
        });

        it('no envía joined al propio publicador', async () => {
            const a = await connect();
            await publish(a, 'p-self');
            const noSelf = await a.expectNoMessage((m) => m.type === 'joined' && m.token === a.token, 200);
            expect(noSelf).toBe(true);
        });

        it('cada miembro existente recibe joined cuando entra uno nuevo', async () => {
            const a = await connect();
            const b = await connect();
            const c = await connect();

            await publish(a, 'p-three');
            await publish(b, 'p-three');
            await publish(c, 'p-three');

            const aGotB = a.recv.find((m) => m.type === 'joined' && m.token === b.token);
            const aGotC = a.recv.find((m) => m.type === 'joined' && m.token === c.token);
            const bGotC = b.recv.find((m) => m.type === 'joined' && m.token === c.token);
            expect(aGotB).toBeTruthy();
            expect(aGotC).toBeTruthy();
            expect(bGotC).toBeTruthy();
            // c no debe haber recibido joined (entró último)
            expect(c.recv.find((m) => m.type === 'joined')).toBeFalsy();
        });

        it('emite joined nuevamente en re-publish', async () => {
            const a = await connect();
            const b = await connect();
            await publish(a, 'p-rejoin');
            await publish(b, 'p-rejoin');

            await sleep(50);
            const before = a.recv.filter((m) => m.type === 'joined' && m.token === b.token).length;
            expect(before).toBe(1);

            await publish(b, 'p-rejoin');
            await sleep(100);

            const after = a.recv.filter((m) => m.type === 'joined' && m.token === b.token).length;
            expect(after).toBe(2);
        });
    });

    describe('left', () => {
        it('avisa a los miembros restantes cuando alguien hace unpublish', async () => {
            const a = await connect();
            const b = await connect();
            await publish(a, 'p-leave');
            await publish(b, 'p-leave');

            b.send({ type: 'unpublish', channel: makeMockChannel('p-leave') });
            await b.waitFor((m) => m.type === 'unpublished');

            const evt = await a.waitFor((m) => m.type === 'left');
            expect(evt).toMatchObject({
                type: 'left',
                token: b.token,
                channel: 'p-leave'
            });
        });

        it('el propio cliente no recibe left', async () => {
            const a = await connect();
            await publish(a, 'p-leave-self');
            a.send({ type: 'unpublish', channel: makeMockChannel('p-leave-self') });
            await a.waitFor((m) => m.type === 'unpublished');

            const noSelf = await a.expectNoMessage((m) => m.type === 'left', 200);
            expect(noSelf).toBe(true);
        });
    });

    describe('disconnected (cierre de socket)', () => {
        it('emite disconnected con channel a los miembros del canal', async () => {
            const a = await connect();
            const b = await connect();
            await publish(a, 'p-disc');
            await publish(b, 'p-disc');

            const tokenB = b.token;
            await b.close();
            const idx = clients.indexOf(b);
            if (idx >= 0) clients.splice(idx, 1);

            const evt = await a.waitFor((m) => m.type === 'disconnected' && m.token === tokenB);
            expect(evt.channel).toBe('p-disc');
        });

        it('NO emite left adicional cuando alguien cierra socket sin unpublish', async () => {
            const a = await connect();
            const b = await connect();
            await publish(a, 'p-no-left');
            await publish(b, 'p-no-left');

            const tokenB = b.token;
            await b.close();
            const idx = clients.indexOf(b);
            if (idx >= 0) clients.splice(idx, 1);

            await a.waitFor((m) => m.type === 'disconnected' && m.token === tokenB);

            const noLeft = await a.expectNoMessage((m) => m.type === 'left' && m.token === tokenB, 200);
            expect(noLeft).toBe(true);
        });

        it('NO notifica a clientes que no comparten canal ni par', async () => {
            const a = await connect();
            const b = await connect();
            const d = await connect(); // observer
            await publish(a, 'p-iso');
            await publish(b, 'p-iso');

            const tokenB = b.token;
            await b.close();
            const idx = clients.indexOf(b);
            if (idx >= 0) clients.splice(idx, 1);

            await a.waitFor((m) => m.type === 'disconnected' && m.token === tokenB);

            const none = await d.expectNoMessage((m) => m.type === 'disconnected', 200);
            expect(none).toBe(true);
        });

        it('emite disconnected sin channel a pares que no comparten canal', async () => {
            const a = await connect();
            const b = await connect();

            a.send({ to: b.token, message: 'hi' });
            await b.waitFor((m) => m.type === 'message');

            const tokenB = b.token;
            await b.close();
            const idx = clients.indexOf(b);
            if (idx >= 0) clients.splice(idx, 1);

            const evt = await a.waitFor((m) => m.type === 'disconnected' && m.token === tokenB);
            expect(evt.channel).toBeUndefined();
        });

        it('dedup: par + canal compartido recibe UN solo disconnected (con channel)', async () => {
            const a = await connect();
            const b = await connect();
            await publish(a, 'p-dedup');
            await publish(b, 'p-dedup');

            a.send({ to: b.token, message: 'pareo' });
            await b.waitFor((m) => m.type === 'message');

            const tokenB = b.token;
            await b.close();
            const idx = clients.indexOf(b);
            if (idx >= 0) clients.splice(idx, 1);

            const first = await a.waitFor((m) => m.type === 'disconnected' && m.token === tokenB);
            expect(first.channel).toBe('p-dedup');

            await sleep(150);
            const all = a.recv.filter((m) => m.type === 'disconnected' && m.token === tokenB);
            expect(all.length).toBe(1);
        });
    });
});
