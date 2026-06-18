import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
    startTestServer,
    stopTestServer,
    connectClient,
    makeMockChannel
} from './helpers.mjs';

describe('channels: publish / unpublish / list / channel_count', () => {
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

    describe('publish', () => {
        it('publica con formato firmado válido y devuelve published', async () => {
            const a = await connect();
            a.send({ type: 'publish', channel: makeMockChannel('room-pub-ok') });

            const res = await a.waitFor((m) => m.type === 'published');
            expect(res.channel).toBe('room-pub-ok');
            expect(res.data).toMatchObject({
                name: 'room-pub-ok',
                publickey: 'mock-pubkey-room-pub-ok'
            });
        });

        it('rechaza canal sin "data"', async () => {
            const a = await connect();
            a.send({ type: 'publish', channel: { signature: 'MOCK-AAAAAAAAAAAAAAAAAAAA' } });
            const err = await a.waitFor((m) => m.type === 'error');
            expect(err.error).toMatch(/data/i);
        });

        it('rechaza canal sin "signature"', async () => {
            const a = await connect();
            a.send({
                type: 'publish',
                channel: { data: { name: 'x', publickey: 'pk' } }
            });
            const err = await a.waitFor((m) => m.type === 'error');
            expect(err.error).toMatch(/signature/i);
        });

        it('rechaza canal con data.name faltante', async () => {
            const a = await connect();
            a.send({
                type: 'publish',
                channel: {
                    data: { publickey: 'pk' },
                    signature: 'MOCK-AAAAAAAAAAAAAAAAAAAA'
                }
            });
            const err = await a.waitFor((m) => m.type === 'error');
            expect(err.error).toMatch(/name/i);
        });

        it('rechaza firma demasiado corta (base64 < 10)', async () => {
            const a = await connect();
            a.send({
                type: 'publish',
                channel: {
                    data: { name: 'x', publickey: 'pk' },
                    signature: 'aaaa'
                }
            });
            const err = await a.waitFor((m) => m.type === 'error');
            expect(err.error).toMatch(/firma inválida/i);
        });
    });

    describe('list', () => {
        it('devuelve los tokens publicados en el canal', async () => {
            const a = await connect();
            const b = await connect();

            a.send({ type: 'publish', channel: makeMockChannel('room-list') });
            await a.waitFor((m) => m.type === 'published');

            b.send({ type: 'publish', channel: makeMockChannel('room-list') });
            await b.waitFor((m) => m.type === 'published');

            b.send({ type: 'list', channel: makeMockChannel('room-list') });
            const res = await b.waitFor((m) => m.type === 'channel_list');

            expect(res.channel).toBe('room-list');
            expect(res.count).toBe(2);
            expect(new Set(res.tokens)).toEqual(new Set([a.token, b.token]));
            expect(res.maxEntries).toBe(100);
        });

        it('devuelve count 0 para canal vacío/inexistente', async () => {
            const a = await connect();
            a.send({ type: 'list', channel: makeMockChannel('canal-fantasma') });
            const res = await a.waitFor((m) => m.type === 'channel_list');
            expect(res.count).toBe(0);
            expect(res.tokens).toEqual([]);
        });
    });

    describe('channel_count', () => {
        it('devuelve solo el conteo sin requerir firma', async () => {
            const a = await connect();
            const b = await connect();

            a.send({ type: 'publish', channel: makeMockChannel('room-count') });
            await a.waitFor((m) => m.type === 'published');

            b.send({ type: 'channel_count', channel: 'room-count' });
            const res = await b.waitFor((m) => m.type === 'channel_count');

            expect(res.channel).toBe('room-count');
            expect(res.count).toBe(1);
            expect(res.maxEntries).toBe(100);
            expect(res.timestamp).toEqual(expect.any(String));
        });

        it('devuelve count 0 para canal inexistente', async () => {
            const a = await connect();
            a.send({ type: 'channel_count', channel: 'nope' });
            const res = await a.waitFor((m) => m.type === 'channel_count');
            expect(res.count).toBe(0);
        });

        it('rechaza channel vacío o no-string', async () => {
            const a = await connect();
            a.send({ type: 'channel_count', channel: '' });
            const err1 = await a.waitFor((m) => m.type === 'error', { fromNow: true });
            expect(err1.error).toMatch(/channel/i);

            a.send({ type: 'channel_count', channel: 123 });
            const err2 = await a.waitFor((m) => m.type === 'error', { fromNow: true });
            expect(err2.error).toMatch(/channel/i);
        });

        it('echoes id en la respuesta', async () => {
            const a = await connect();
            a.send({ type: 'channel_count', channel: 'x', id: 99 });
            const res = await a.waitFor((m) => m.type === 'channel_count');
            expect(res.id).toBe(99);
        });
    });

    describe('list_channels', () => {
        it('lista todos los canales con count > 0', async () => {
            const a = await connect();
            const b = await connect();

            a.send({ type: 'publish', channel: makeMockChannel('chat_room_general') });
            await a.waitFor((m) => m.type === 'published');

            b.send({ type: 'publish', channel: makeMockChannel('chat_room_prueba') });
            await b.waitFor((m) => m.type === 'published');

            const c = await connect();
            c.send({ type: 'list_channels' });
            const res = await c.waitFor((m) => m.type === 'channels_list');

            const names = res.channels.map(ch => ch.name);
            expect(names).toContain('chat_room_general');
            expect(names).toContain('chat_room_prueba');

            const general = res.channels.find(ch => ch.name === 'chat_room_general');
            const prueba = res.channels.find(ch => ch.name === 'chat_room_prueba');
            expect(general.count).toBe(1);
            expect(prueba.count).toBe(1);
        });

        it('filtra por prefix y echoa el prefix en la respuesta', async () => {
            const a = await connect();
            const b = await connect();

            a.send({ type: 'publish', channel: makeMockChannel('chat_room_general') });
            await a.waitFor((m) => m.type === 'published');
            b.send({ type: 'publish', channel: makeMockChannel('other_namespace') });
            await b.waitFor((m) => m.type === 'published');

            const c = await connect();
            c.send({ type: 'list_channels', prefix: 'chat_room_' });
            const res = await c.waitFor((m) => m.type === 'channels_list');

            expect(res.prefix).toBe('chat_room_');
            const names = res.channels.map(ch => ch.name);
            expect(names).toContain('chat_room_general');
            expect(names).not.toContain('other_namespace');
        });

        it('omite canales vacíos', async () => {
            const a = await connect();
            a.send({ type: 'publish', channel: makeMockChannel('chat_room_temp') });
            await a.waitFor((m) => m.type === 'published');
            a.send({ type: 'unpublish', channel: makeMockChannel('chat_room_temp') });
            await a.waitFor((m) => m.type === 'unpublished');

            a.send({ type: 'list_channels', prefix: 'chat_room_temp' });
            const res = await a.waitFor((m) => m.type === 'channels_list');
            expect(res.channels).toEqual([]);
        });

        it('echoes id', async () => {
            const a = await connect();
            a.send({ type: 'list_channels', id: 11 });
            const res = await a.waitFor((m) => m.type === 'channels_list');
            expect(res.id).toBe(11);
        });
    });

    describe('unpublish', () => {
        it('quita el token del canal', async () => {
            const a = await connect();
            const b = await connect();

            a.send({ type: 'publish', channel: makeMockChannel('room-unpub') });
            await a.waitFor((m) => m.type === 'published');

            a.send({ type: 'unpublish', channel: makeMockChannel('room-unpub') });
            await a.waitFor((m) => m.type === 'unpublished');

            b.send({ type: 'channel_count', channel: 'room-unpub' });
            const res = await b.waitFor((m) => m.type === 'channel_count');
            expect(res.count).toBe(0);
        });
    });

    describe('re-publish', () => {
        it('mantiene una sola entrada por token tras re-publish', async () => {
            const a = await connect();

            for (let i = 0; i < 3; i++) {
                a.send({ type: 'publish', channel: makeMockChannel('room-dup') });
                await a.waitFor((m) => m.type === 'published', { fromNow: true });
            }

            a.send({ type: 'channel_count', channel: 'room-dup' });
            const res = await a.waitFor((m) => m.type === 'channel_count');
            expect(res.count).toBe(1);
        });
    });
});
