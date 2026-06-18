import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
    startTestServer,
    stopTestServer,
    connectClient
} from './helpers.mjs';

describe('manual disconnect message', () => {
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

    it('A pareado con B desconecta a B → ambos reciben disconnected', async () => {
        const a = await connect();
        const b = await connect();

        a.send({ to: b.token, message: 'hola' });
        await b.waitFor((m) => m.type === 'message');

        a.send({ type: 'disconnect', target: b.token });

        const [ackA, evtB] = await Promise.all([
            a.waitFor((m) => m.type === 'disconnect_confirmation'),
            b.waitFor((m) => m.type === 'disconnected')
        ]);

        expect(ackA.target).toBe(b.token);
        expect(evtB.token).toBe(a.token);
        const aGot = await a.waitFor((m) => m.type === 'disconnected' && m.token === b.token);
        expect(aGot).toBeTruthy();
    });

    it('rechaza desconectarse de uno mismo', async () => {
        const a = await connect();
        a.send({ type: 'disconnect', target: a.token });
        const err = await a.waitFor((m) => m.type === 'error');
        expect(err.error).toMatch(/ti mismo/i);
    });

    it('rechaza target inexistente', async () => {
        const a = await connect();
        a.send({ type: 'disconnect', target: 'ZZZZ' });
        const err = await a.waitFor((m) => m.type === 'error');
        expect(err.error).toMatch(/no encontrado/i);
    });

    it('rechaza si los tokens no están pareados', async () => {
        const a = await connect();
        const b = await connect();
        a.send({ type: 'disconnect', target: b.token });
        const err = await a.waitFor((m) => m.type === 'error');
        expect(err.error).toMatch(/no están pareados/i);
    });

    it('rechaza target faltante o no-string', async () => {
        const a = await connect();
        a.send({ type: 'disconnect' });
        const err1 = await a.waitFor((m) => m.type === 'error', { fromNow: true });
        expect(err1.error).toMatch(/token destino/i);

        a.send({ type: 'disconnect', target: 123 });
        const err2 = await a.waitFor((m) => m.type === 'error', { fromNow: true });
        expect(err2.error).toMatch(/token destino/i);
    });

    it('echo de id en disconnect_confirmation', async () => {
        const a = await connect();
        const b = await connect();
        a.send({ to: b.token, message: 'pareo' });
        await b.waitFor((m) => m.type === 'message');

        a.send({ type: 'disconnect', target: b.token, id: 7 });
        const ack = await a.waitFor((m) => m.type === 'disconnect_confirmation');
        expect(ack.id).toBe(7);
    });
});
