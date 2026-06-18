import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
    startTestServer,
    stopTestServer,
    connectClient
} from './helpers.mjs';

describe('core: connection & messaging', () => {
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

    describe('token assignment', () => {
        it('asigna un token de 4 caracteres alfanuméricos al conectar', async () => {
            const a = await connect();
            expect(a.token).toMatch(/^[1-9A-Z]{4}$/);
        });

        it('asigna tokens distintos a clientes distintos', async () => {
            const a = await connect();
            const b = await connect();
            const c = await connect();
            const tokens = new Set([a.token, b.token, c.token]);
            expect(tokens.size).toBe(3);
        });
    });

    describe('point-to-point messaging', () => {
        it('A → B entrega el mensaje con shape esperado', async () => {
            const a = await connect();
            const b = await connect();

            a.send({ to: b.token, message: 'hola' });

            const msg = await b.waitFor((m) => m.type === 'message');
            expect(msg).toMatchObject({
                type: 'message',
                from: a.token,
                message: 'hola'
            });
        });

        it('A → [B, C] entrega el mensaje a ambos', async () => {
            const a = await connect();
            const b = await connect();
            const c = await connect();

            a.send({ to: [b.token, c.token], message: 'broadcast' });

            const [mb, mc] = await Promise.all([
                b.waitFor((m) => m.type === 'message'),
                c.waitFor((m) => m.type === 'message')
            ]);
            expect(mb.message).toBe('broadcast');
            expect(mc.message).toBe('broadcast');
            expect(mb.from).toBe(a.token);
            expect(mc.from).toBe(a.token);
        });

        it('A → token inexistente reporta failed en message_sent', async () => {
            const a = await connect();
            const b = await connect();

            a.send({ to: [b.token, 'ZZZZ'], message: 'parcial' });

            const ack = await a.waitFor((m) => m.type === 'message_sent');
            expect(ack.sent).toBe(1);
            expect(ack.total).toBe(2);
            expect(ack.failed).toEqual(['ZZZZ']);
        });

        it('NO emite message_sent cuando todos los destinos son válidos', async () => {
            const a = await connect();
            const b = await connect();

            a.send({ to: b.token, message: 'ok' });
            await b.waitFor((m) => m.type === 'message');

            const noAck = await a.expectNoMessage((m) => m.type === 'message_sent', 150);
            expect(noAck).toBe(true);
        });

        it('rechaza enviar mensaje a uno mismo', async () => {
            const a = await connect();
            a.send({ to: a.token, message: 'self' });

            const err = await a.waitFor((m) => m.type === 'error');
            expect(err.error).toMatch(/no puedes enviarte mensajes a ti mismo/i);
        });

        it('rechaza mensajes sin "to" o sin "message"', async () => {
            const a = await connect();

            a.send({ message: 'sin to' });
            const err1 = await a.waitFor((m) => m.type === 'error', { fromNow: true });
            expect(err1.error).toMatch(/formato de mensaje inválido/i);

            a.send({ to: 'AAAA' });
            const err2 = await a.waitFor((m) => m.type === 'error', { fromNow: true });
            expect(err2.error).toMatch(/formato de mensaje inválido/i);
        });

        it('rechaza array "to" vacío', async () => {
            const a = await connect();
            a.send({ to: [], message: 'vacío' });
            const err = await a.waitFor((m) => m.type === 'error');
            expect(err.error).toMatch(/al menos un token/i);
        });
    });

    describe('id / messageId echo', () => {
        it('echo de id en message_sent (parcial)', async () => {
            const a = await connect();
            a.send({ to: ['ZZZZ'], message: 'x', id: 42 });
            const ack = await a.waitFor((m) => m.type === 'message_sent');
            expect(ack.id).toBe(42);
        });

        it('echo de messageId en error', async () => {
            const a = await connect();
            a.send({ to: a.token, message: 'self', messageId: 'msg-1' });
            const err = await a.waitFor((m) => m.type === 'error');
            expect(err.messageId).toBe('msg-1');
        });

        it('echo de ambos id y messageId', async () => {
            const a = await connect();
            a.send({ to: ['ZZZZ'], message: 'x', id: 7, messageId: 'mid-7' });
            const ack = await a.waitFor((m) => m.type === 'message_sent');
            expect(ack.id).toBe(7);
            expect(ack.messageId).toBe('mid-7');
        });
    });
});
