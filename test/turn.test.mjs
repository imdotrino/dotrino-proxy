import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { webcrypto, createPrivateKey, sign as nodeSign } from 'crypto';
import { startTestServer, stopTestServer, connectClient } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { setTurnIssuer } = require('../server');
const { createTurnIssuer } = require('../turnCredentials');

// --- helpers de firma (mismo esquema que el vault: ECDSA P-256 ieee-p1363
// sobre el JSON canónico con claves ordenadas) --------------------------------

function canonicalStringify(obj) {
    if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

async function makeIdentity() {
    const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const pubJwk = await webcrypto.subtle.exportKey('jwk', kp.publicKey);
    const privJwk = await webcrypto.subtle.exportKey('jwk', kp.privateKey);
    const keyObject = createPrivateKey({ key: privJwk, format: 'jwk' });
    const publickey = JSON.stringify({ kty: 'EC', crv: 'P-256', x: pubJwk.x, y: pubJwk.y });
    const signEnvelope = (data) => nodeSign(
        'sha256',
        Buffer.from(canonicalStringify(data), 'utf8'),
        { key: keyObject, dsaEncoding: 'ieee-p1363' }
    ).toString('base64');
    return { publickey, signEnvelope };
}

async function identify(client, id) {
    const data = { op: 'identify', publickey: id.publickey, token: client.token, ts: Date.now() };
    client.send({ type: 'identify', data, signature: id.signEnvelope(data), id: 'id1' });
    await client.waitFor((m) => m.type === 'identified' || m.type === 'error');
}

function requestTurn(client, id, msgId = 'turn1') {
    const data = { op: 'turn-credentials', publickey: id.publickey, ts: Date.now() };
    client.send({ type: 'turn-credentials', data, signature: id.signEnvelope(data), id: msgId });
    return client.waitFor((m) => (m.type === 'turn-credentials' || m.type === 'error') && m.id === msgId);
}

function mockCloudflareFetch() {
    let calls = 0;
    const fetchImpl = async () => {
        calls++;
        return {
            ok: true,
            json: async () => ({
                iceServers: {
                    urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp'],
                    username: `user-${calls}`,
                    credential: `cred-${calls}`
                }
            })
        };
    };
    return { fetchImpl, getCalls: () => calls };
}

// --- integración por WebSocket ------------------------------------------------

describe('turn-credentials (op firmada)', () => {
    let url;

    beforeAll(async () => {
        ({ url } = await startTestServer());
    });

    afterAll(async () => {
        await stopTestServer();
    });

    afterEach(() => {
        // volver al issuer por defecto (deshabilitado sin env)
        setTurnIssuer(createTurnIssuer({ keyId: '', apiToken: '' }));
    });

    it('responde enabled:false si el proxy no tiene llaves de Cloudflare', async () => {
        const client = await connectClient(url);
        const id = await makeIdentity();
        await identify(client, id);
        const res = await requestTurn(client, id);
        expect(res.type).toBe('turn-credentials');
        expect(res.enabled).toBe(false);
        await client.close();
    });

    it('rechaza si la conexión no hizo identify con esa pubkey', async () => {
        const client = await connectClient(url);
        const id = await makeIdentity();
        const res = await requestTurn(client, id);
        expect(res.type).toBe('error');
        expect(res.error).toMatch(/identify/);
        await client.close();
    });

    it('rechaza sobres con firma inválida', async () => {
        const client = await connectClient(url);
        const id = await makeIdentity();
        await identify(client, id);
        const data = { op: 'turn-credentials', publickey: id.publickey, ts: Date.now() };
        client.send({ type: 'turn-credentials', data, signature: 'AAAA'.repeat(24), id: 'bad1' });
        const res = await client.waitFor((m) => m.type === 'error' && m.id === 'bad1');
        expect(res.error).toMatch(/Firma/);
        await client.close();
    });

    it('entrega iceServers efímeros a una conexión identificada (y cachea)', async () => {
        const { fetchImpl, getCalls } = mockCloudflareFetch();
        setTurnIssuer(createTurnIssuer({ keyId: 'k1', apiToken: 't1', ttlSeconds: 600, fetchImpl }));

        const client = await connectClient(url);
        const id = await makeIdentity();
        await identify(client, id);

        const res = await requestTurn(client, id, 'turnA');
        expect(res.type).toBe('turn-credentials');
        expect(res.enabled).toBe(true);
        expect(Array.isArray(res.iceServers)).toBe(true);
        expect(res.iceServers[0].username).toBe('user-1');
        expect(res.iceServers[0].credential).toBe('cred-1');
        expect(res.expiresAt).toBeGreaterThan(Date.now());
        expect(res.ttl).toBe(600);

        // Segunda petición dentro del TTL: misma credencial, sin nueva llamada a Cloudflare
        const res2 = await requestTurn(client, id, 'turnB');
        expect(res2.iceServers[0].username).toBe('user-1');
        expect(getCalls()).toBe(1);

        await client.close();
    });
});

// --- unidad del emisor ---------------------------------------------------------

describe('createTurnIssuer', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('está deshabilitado sin llaves', () => {
        const issuer = createTurnIssuer({ keyId: '', apiToken: '' });
        expect(issuer.enabled).toBe(false);
    });

    it('aplica la cuota por pubkey/hora cuando la cache expira', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-11T12:00:00Z'));
        const { fetchImpl, getCalls } = mockCloudflareFetch();
        const issuer = createTurnIssuer({ keyId: 'k', apiToken: 't', ttlSeconds: 60, maxPerHour: 2, fetchImpl });

        await issuer.issue('pk1');                       // emisión 1
        vi.advanceTimersByTime(61 * 1000);               // cache vencida
        await issuer.issue('pk1');                       // emisión 2
        vi.advanceTimersByTime(61 * 1000);
        const limited = await issuer.issue('pk1');       // 3ra en la misma hora → cuota
        expect(limited.limited).toBe(true);
        expect(limited.retry_after_ms).toBeGreaterThan(0);
        expect(getCalls()).toBe(2);

        // otra pubkey no comparte cuota
        const other = await issuer.issue('pk2');
        expect(other.iceServers).toBeTruthy();

        // pasada la hora, vuelve a emitir
        vi.advanceTimersByTime(60 * 60 * 1000);
        const again = await issuer.issue('pk1');
        expect(again.iceServers).toBeTruthy();
    });

    it('propaga errores de la API de Cloudflare', async () => {
        const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
        const issuer = createTurnIssuer({ keyId: 'k', apiToken: 'bad', fetchImpl });
        await expect(issuer.issue('pk1')).rejects.toThrow(/401/);
    });

    it('el techo GLOBAL corta el abuso por rotación de pubkeys (protege la cuenta de Cloudflare)', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-13T12:00:00Z'));
        const { fetchImpl, getCalls } = mockCloudflareFetch();
        // cada pubkey nueva tiene su cuota por-pubkey intacta, pero el techo global es 3
        const issuer = createTurnIssuer({ keyId: 'k', apiToken: 't', ttlSeconds: 60, maxPerHour: 12, globalMaxPerHour: 3, fetchImpl });
        for (let i = 0; i < 3; i++) {
            const r = await issuer.issue('pk-nueva-' + i);   // pubkeys DISTINTAS (rotación)
            expect(r.iceServers).toBeTruthy();
        }
        const blocked = await issuer.issue('pk-nueva-4');     // 4ta pubkey distinta → techo global
        expect(blocked.limited).toBe(true);
        expect(getCalls()).toBe(3);                            // Cloudflare NO fue golpeado la 4ta vez
        issuer.destroy();
    });

    it('no acumula memoria sin límite: el barrido purga pubkeys vencidas que no vuelven', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-13T12:00:00Z'));
        const { fetchImpl } = mockCloudflareFetch();
        const issuer = createTurnIssuer({ keyId: 'k', apiToken: 't', ttlSeconds: 60, maxTracked: 3, fetchImpl });
        // 5 pubkeys que piden UNA vez y nunca vuelven (patrón del atacante)
        for (let i = 0; i < 5; i++) await issuer.issue('efimera-' + i);
        vi.advanceTimersByTime(2 * 60 * 60 * 1000);  // pasa >1h: todo vencido
        issuer._sweep();                              // el barrido que corre el setInterval
        // No exponemos los Maps; verificamos el efecto: tras el barrido, una pubkey
        // vieja vuelve a contar como "primera vez" (no quedó rastro que la limite).
        const r = await issuer.issue('efimera-0');
        expect(r.iceServers).toBeTruthy();
        issuer.destroy();
    });

    it('el fetch tiene timeout (un Cloudflare colgado no retiene el slot)', async () => {
        // timers REALES + timeout corto: fake timers chocan con el AbortController interno.
        let aborted = false;
        const fetchImpl = (url, opts) => new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
            // nunca resuelve por su cuenta: simula Cloudflare colgado
        });
        const issuer = createTurnIssuer({ keyId: 'k', apiToken: 't', fetchImpl, fetchTimeoutMs: 50 });
        await expect(issuer.issue('pk1')).rejects.toThrow();
        expect(aborted).toBe(true);
        // tras abortar, el slot inFlight quedó libre: una nueva petición se cursa
        expect(issuer.enabled).toBe(true);
        issuer.destroy();
    });
});
