import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { startTestServer, stopTestServer, connectClient, sleep } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { setRateLimiter } = require('../server');
const { createRateLimiter } = require('../rateLimiter');

let url;

beforeAll(async () => {
    const srv = await startTestServer();
    url = srv.url;
});

afterAll(async () => {
    setRateLimiter(createRateLimiter({ disabled: true }));
    await stopTestServer();
});

describe('rate limiter — soft tier', () => {
    it('emite abuse_notice al receptor cuando el sender excede el soft burst en mensajes', async () => {
        // Limites bajos para testear rápido
        setRateLimiter(createRateLimiter({
            limits: {
                message:       { burst: 3, ratePerSec: 1 },
                publish:       { burst: 5, ratePerSec: 1 },
                unpublish:     { burst: 5, ratePerSec: 1 },
                list:          { burst: 5, ratePerSec: 1 },
                list_channels: { burst: 5, ratePerSec: 1 },
                channel_count: { burst: 5, ratePerSec: 1 },
                disconnect:    { burst: 5, ratePerSec: 1 },
                __global__:    { burst: 100, ratePerSec: 100 }
            },
            hardMultiplier: 10, // mantener hard lejos
            banMs: 1000
        }));

        const a = await connectClient(url);
        const b = await connectClient(url);

        // 5 mensajes rápidos (burst=3 → al menos uno disparará soft)
        for (let i = 0; i < 5; i++) {
            a.send({ to: [b.token], message: `m${i}` });
        }

        // B recibe los mensajes y al menos un abuse_notice
        const notice = await b.waitFor(m => m.type === 'abuse_notice', { timeout: 1000 });
        expect(notice.from).toBe(a.token);
        expect(notice.operation).toBe('message');
        expect(notice.severity).toBe('soft');

        const messages = b.recv.filter(m => m.type === 'message' && m.from === a.token);
        expect(messages.length).toBeGreaterThanOrEqual(3); // los soft no se rechazan

        await a.close();
        await b.close();
    });

    it('emite abuse_notice al emisor cuando un tipo especial excede el soft', async () => {
        setRateLimiter(createRateLimiter({
            limits: {
                message:       { burst: 100, ratePerSec: 100 },
                publish:       { burst: 100, ratePerSec: 100 },
                unpublish:     { burst: 100, ratePerSec: 100 },
                list:          { burst: 100, ratePerSec: 100 },
                list_channels: { burst: 100, ratePerSec: 100 },
                channel_count: { burst: 2, ratePerSec: 1 },
                disconnect:    { burst: 100, ratePerSec: 100 },
                __global__:    { burst: 100, ratePerSec: 100 }
            },
            hardMultiplier: 10
        }));

        const a = await connectClient(url);
        for (let i = 0; i < 4; i++) {
            a.send({ type: 'channel_count', channel: 'foo' });
        }

        const notice = await a.waitFor(m => m.type === 'abuse_notice', { timeout: 1000 });
        expect(notice.operation).toBe('channel_count');
        expect(notice.severity).toBe('soft');
        expect(notice.from).toBe(a.token);

        // los responses siguen llegando aunque haya soft-limit
        const responses = a.recv.filter(m => m.type === 'channel_count');
        expect(responses.length).toBeGreaterThanOrEqual(2);

        await a.close();
    });
});

describe('rate limiter — hard tier', () => {
    it('rechaza mensaje, cierra conexión y banea IP cuando excede hard', async () => {
        setRateLimiter(createRateLimiter({
            limits: {
                message:       { burst: 2, ratePerSec: 1 },
                publish:       { burst: 5, ratePerSec: 1 },
                unpublish:     { burst: 5, ratePerSec: 1 },
                list:          { burst: 5, ratePerSec: 1 },
                list_channels: { burst: 5, ratePerSec: 1 },
                channel_count: { burst: 5, ratePerSec: 1 },
                disconnect:    { burst: 5, ratePerSec: 1 },
                __global__:    { burst: 1000, ratePerSec: 1000 }
            },
            hardMultiplier: 2, // hard burst = 4
            banMs: 5000,
            banDisabled: false // este test verifica el corte+ban: hay que habilitarlo
        }));

        const a = await connectClient(url);
        const b = await connectClient(url);

        const closed = new Promise((resolve) => {
            a.ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
        });

        for (let i = 0; i < 10; i++) {
            try { a.send({ to: [b.token], message: `m${i}` }); } catch (_) {}
        }

        const errMsg = await a.waitFor(m => m.type === 'error' && m.limit_level === 'hard', { timeout: 1500 });
        expect(errMsg.operation).toBe('message');
        expect(errMsg.retry_after_ms).toBeGreaterThan(0);

        const closeInfo = await closed;
        expect(closeInfo.code).toBe(1008);

        // Reconexión inmediata desde misma IP debe quedar baneada
        const banned = await connectClient(url).catch(e => e);
        // connectClient timeout/cierra → check via WebSocket directo
        // En este caso connectClient lanza por timeout; no lanza por close. Hagamos socket raw.
        const WS = require('ws');
        const raw = new WS(url);
        const banResult = await new Promise((resolve) => {
            const onMsg = (data) => {
                try {
                    const m = JSON.parse(data.toString());
                    if (m.type === 'error' && m.limit_type === 'ip_ban') {
                        resolve(m);
                    }
                } catch (_) {}
            };
            raw.on('message', onMsg);
            raw.on('close', () => resolve(null));
            setTimeout(() => resolve(null), 1500);
        });
        expect(banResult).not.toBeNull();
        expect(banResult.limit_type).toBe('ip_ban');
        try { raw.close(); } catch (_) {}

        await b.close();
    });
});

describe('rate limiter — refill', () => {
    it('tras agotar el soft, esperar suficiente devuelve operaciones a ok', async () => {
        setRateLimiter(createRateLimiter({
            limits: {
                message:       { burst: 2, ratePerSec: 4 }, // 250ms para 1 token
                publish:       { burst: 5, ratePerSec: 1 },
                unpublish:     { burst: 5, ratePerSec: 1 },
                list:          { burst: 5, ratePerSec: 1 },
                list_channels: { burst: 5, ratePerSec: 1 },
                channel_count: { burst: 5, ratePerSec: 1 },
                disconnect:    { burst: 5, ratePerSec: 1 },
                __global__:    { burst: 100, ratePerSec: 100 }
            },
            hardMultiplier: 10
        }));

        const a = await connectClient(url);
        const b = await connectClient(url);

        // Drenar burst → notice
        for (let i = 0; i < 4; i++) a.send({ to: [b.token], message: `m${i}` });
        await b.waitFor(m => m.type === 'abuse_notice', { timeout: 1000 });

        const beforeCount = b.recv.filter(m => m.type === 'abuse_notice').length;

        // Esperar 600ms → bucket recuperó >2 tokens
        await sleep(600);

        // Enviar 1 mensaje fresco; no debería causar nuevo notice
        a.send({ to: [b.token], message: 'fresh' });
        await sleep(200);
        const afterCount = b.recv.filter(m => m.type === 'abuse_notice').length;
        expect(afterCount).toBe(beforeCount);

        await a.close();
        await b.close();
    });
});

describe('rate limiter — kill switch', () => {
    it('con disabled=true no aplica limites ni emite notices', async () => {
        setRateLimiter(createRateLimiter({ disabled: true }));

        const a = await connectClient(url);
        const b = await connectClient(url);

        // 100 mensajes seguidos
        for (let i = 0; i < 100; i++) a.send({ to: [b.token], message: `m${i}` });

        await sleep(300);
        const notices = b.recv.filter(m => m.type === 'abuse_notice');
        expect(notices.length).toBe(0);

        const messages = b.recv.filter(m => m.type === 'message');
        expect(messages.length).toBe(100);

        await a.close();
        await b.close();
    });
});

describe('rate limiter — aislamiento', () => {
    it('un token saturado no afecta a otro token', async () => {
        setRateLimiter(createRateLimiter({
            limits: {
                message:       { burst: 2, ratePerSec: 1 },
                publish:       { burst: 5, ratePerSec: 1 },
                unpublish:     { burst: 5, ratePerSec: 1 },
                list:          { burst: 5, ratePerSec: 1 },
                list_channels: { burst: 5, ratePerSec: 1 },
                channel_count: { burst: 5, ratePerSec: 1 },
                disconnect:    { burst: 5, ratePerSec: 1 },
                __global__:    { burst: 100, ratePerSec: 100 }
            },
            hardMultiplier: 10
        }));

        const a = await connectClient(url);
        const b = await connectClient(url);
        const c = await connectClient(url);

        // A satura mandando a C
        for (let i = 0; i < 5; i++) a.send({ to: [c.token], message: `mA${i}` });
        await c.waitFor(m => m.type === 'abuse_notice' && m.from === a.token, { timeout: 1000 });

        // B manda 1 mensaje a C — sin notice
        b.send({ to: [c.token], message: 'mB' });
        await c.waitFor(m => m.type === 'message' && m.from === b.token, { timeout: 1000 });

        const noticesFromB = c.recv.filter(m => m.type === 'abuse_notice' && m.from === b.token);
        expect(noticesFromB.length).toBe(0);

        await a.close();
        await b.close();
        await c.close();
    });
});

describe('rate limiter — releaseToken al cerrar', () => {
    it('limpia el estado del rate limiter cuando un cliente cierra', async () => {
        const limiter = createRateLimiter({
            limits: {
                message:       { burst: 2, ratePerSec: 1 },
                publish:       { burst: 5, ratePerSec: 1 },
                unpublish:     { burst: 5, ratePerSec: 1 },
                list:          { burst: 5, ratePerSec: 1 },
                list_channels: { burst: 5, ratePerSec: 1 },
                channel_count: { burst: 5, ratePerSec: 1 },
                disconnect:    { burst: 5, ratePerSec: 1 },
                __global__:    { burst: 100, ratePerSec: 100 }
            },
            hardMultiplier: 10
        });
        setRateLimiter(limiter);

        const a = await connectClient(url);
        a.send({ type: 'channel_count', channel: 'x' });
        await sleep(100);
        expect(limiter._stats().tokenCount).toBeGreaterThan(0);

        await a.close();
        await sleep(150);
        expect(limiter._stats().tokenCount).toBe(0);
    });
});
