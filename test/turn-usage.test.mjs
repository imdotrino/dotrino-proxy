// El tope diario de tráfico del TURN (`turnUsage.js`) y su aviso (`alerts.js`).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createTurnUsage } = require('../turnUsage');
const { createTurnIssuer } = require('../turnCredentials');
const { sendAlert, turnAlertText } = require('../alerts');

const GB = 1e9;
const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);

// Un Cloudflare de mentira: `reply()` dice qué contesta la API de analíticas cada vez.
function analytics(reply) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push(JSON.parse(init.body));
        const r = reply(calls.length);
        if (r instanceof Error) throw r;
        if (r.status) return { ok: false, status: r.status, json: async () => ({}) };
        return { ok: true, json: async () => r };
    };
    return { fetchImpl, calls };
}
const usageReply = (egressBytes) => ({ data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: egressBytes == null ? [] : [{ sum: { egressBytes, ingressBytes: 1 } }] }] } } });

function make(reply, extra = {}) {
    const clock = { t: T0 };
    const alerts = [];
    const a = analytics(reply);
    const usage = createTurnUsage({
        accountId: 'acc', apiToken: 'tok', keyId: 'key1', dailyGb: 20, pollSeconds: 300,
        fetchImpl: a.fetchImpl, now: () => clock.t, onAlert: (e) => alerts.push(e), ...extra
    });
    return { usage, clock, alerts, calls: a.calls };
}

describe('createTurnUsage', () => {
    it('is off without the account id or the analytics token, and then it never blocks', () => {
        const u = createTurnUsage({ accountId: '', apiToken: '', keyId: 'key1' });
        expect(u.enabled).toBe(false);
        expect(u.allowed()).toEqual({ ok: true });
    });

    it('asks Cloudflare for today (UTC) and this key, and allows under the cap', async () => {
        const { usage, calls } = make(() => usageReply(5 * GB));
        await usage.refresh();
        expect(calls[0].variables).toEqual({ account: 'acc', from: '2026-10-13', to: '2026-10-13', key: 'key1' });
        expect(usage.allowed()).toEqual({ ok: true });
        expect(usage.state().egressBytes).toBe(5 * GB);
    });

    it('a day with no rows is zero traffic', async () => {
        const { usage } = make(() => usageReply(null));
        await usage.refresh();
        expect(usage.state().egressBytes).toBe(0);
        expect(usage.allowed().ok).toBe(true);
    });

    it('at the cap it stops until the next UTC day, and alerts ONCE that day', async () => {
        const { usage, alerts, clock } = make(() => usageReply(20 * GB));
        await usage.refresh();
        const r = usage.allowed();
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('turn-daily-cap');
        expect(r.retry_after_ms).toBe(12 * 60 * 60 * 1000);
        clock.t += 300 * 1000;
        await usage.refresh();
        expect(alerts).toEqual([{ kind: 'turn-daily-cap', day: '2026-10-13', egressBytes: 20 * GB, capBytes: 20 * GB }]);
    });

    it('the next day starts clean, and a new cap day alerts again', async () => {
        let bytes = 25 * GB;
        const { usage, alerts, clock } = make(() => usageReply(bytes));
        await usage.refresh();
        clock.t += 13 * 60 * 60 * 1000; // ya es el 14
        expect(usage.allowed().reason).toBe('turn-usage-unknown'); // la lectura de ayer no dice nada de hoy
        bytes = 1 * GB;
        await usage.refresh();
        expect(usage.allowed().ok).toBe(true);
        bytes = 21 * GB;
        await usage.refresh();
        expect(alerts.map((a) => a.day)).toEqual(['2026-10-13', '2026-10-14']);
    });

    it('with no reading at all it does NOT issue, and says so once', async () => {
        const { usage, alerts } = make(() => ({ status: 403 }));
        expect(usage.allowed().reason).toBe('turn-usage-unknown');
        await usage.refresh();
        await usage.refresh();
        expect(usage.allowed().reason).toBe('turn-usage-unknown');
        expect(alerts).toHaveLength(1);
        expect(alerts[0].kind).toBe('turn-usage-unknown');
        expect(alerts[0].error).toMatch(/403/);
    });

    it('one failed poll does not close it while the last good reading is recent; a stale one does', async () => {
        let fail = false;
        const { usage, alerts, clock } = make(() => (fail ? new Error('boom') : usageReply(1 * GB)));
        await usage.refresh();
        fail = true;
        clock.t += 300 * 1000;
        await usage.refresh();
        expect(usage.allowed().ok).toBe(true);
        expect(alerts).toHaveLength(0);
        clock.t += 20 * 60 * 1000;
        await usage.refresh();
        expect(usage.allowed().reason).toBe('turn-usage-unknown');
        expect(alerts).toHaveLength(1);
        // Y vuelve solo con la siguiente lectura buena.
        fail = false;
        await usage.refresh();
        expect(usage.allowed().ok).toBe(true);
    });

    it('an account the token cannot see, or a GraphQL error, is not "zero traffic"', async () => {
        for (const body of [{ data: { viewer: { accounts: [] } } }, { errors: [{ message: 'not authorized' }], data: null }]) {
            const { usage } = make(() => body);
            await usage.refresh();
            expect(usage.allowed().reason).toBe('turn-usage-unknown');
            expect(usage.state().lastError).toBeTruthy();
        }
    });
});

describe('createTurnIssuer with the daily cap', () => {
    const cloudflare = () => {
        let calls = 0;
        return { fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ iceServers: { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' } }) }; }, calls: () => calls };
    };

    it('under the cap it issues; at the cap it does not, not even a cached credential', async () => {
        let bytes = 1 * GB;
        const { usage } = make(() => usageReply(bytes));
        const cf = cloudflare();
        const issuer = createTurnIssuer({ keyId: 'key1', apiToken: 't', fetchImpl: cf.fetchImpl, usage });
        const ok = await issuer.issue('pk1');
        expect(ok.iceServers[0].username).toBe('u');
        bytes = 20 * GB;
        await usage.refresh();
        const no = await issuer.issue('pk1');
        expect(no.limited).toBe(true);
        expect(no.reason).toBe('turn-daily-cap');
        expect(cf.calls()).toBe(1);
        issuer.destroy();
    });

    it('a request that arrives before the first reading waits for it instead of bouncing', async () => {
        const { usage } = make(() => usageReply(1 * GB));
        const issuer = createTurnIssuer({ keyId: 'key1', apiToken: 't', fetchImpl: cloudflare().fetchImpl, usage });
        // `start()` ya lanzó la primera lectura y todavía no volvió.
        expect(usage.allowed().reason).toBe('turn-usage-unknown');
        const r = await issuer.issue('pk1');
        expect(r.limited).toBeUndefined();
        expect(r.iceServers).toBeTruthy();
        issuer.destroy();
    });

    it('without a reading it does not issue', async () => {
        const { usage } = make(() => ({ status: 500 }));
        const cf = cloudflare();
        const issuer = createTurnIssuer({ keyId: 'key1', apiToken: 't', fetchImpl: cf.fetchImpl, usage });
        const r = await issuer.issue('pk1');
        expect(r).toMatchObject({ limited: true, reason: 'turn-usage-unknown' });
        expect(cf.calls()).toBe(0);
        issuer.destroy();
    });
});

describe('sendAlert', () => {
    const ev = { kind: 'turn-daily-cap', day: '2026-10-13', egressBytes: 20.5 * GB, capBytes: 20 * GB };

    it('sends the email through Resend and always logs it', async () => {
        const sent = []; const logs = [];
        const r = await sendAlert(turnAlertText(ev, 'wss://proxy.example'), {
            env: { ALERT_RESEND_API_KEY: 'k', ALERT_EMAIL_TO: 'to@example.com', ALERT_EMAIL_FROM: 'Dotrino <a@example.com>' },
            fetchImpl: async (url, init) => { sent.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) }); return { ok: true }; },
            log: (l) => logs.push(l)
        });
        expect(r).toEqual({ sent: true });
        expect(sent[0].url).toBe('https://api.resend.com/emails');
        expect(sent[0].auth).toBe('Bearer k');
        expect(sent[0].body.to).toEqual(['to@example.com']);
        expect(sent[0].body.subject).toMatch(/daily cap reached \(20\.50 GB\)/);
        expect(sent[0].body.text).toMatch(/wss:\/\/proxy\.example/);
        expect(logs[0]).toMatch(/^\[alert\] /);
    });

    it('with no email configured, or a Resend failure, it says the alert was NOT sent', async () => {
        const logs = [];
        const a = await sendAlert(turnAlertText(ev), { env: {}, fetchImpl: async () => ({ ok: true }), log: (l) => logs.push(l) });
        expect(a).toEqual({ sent: false, reason: 'not-configured' });
        const env = { ALERT_RESEND_API_KEY: 'k', ALERT_EMAIL_TO: 't', ALERT_EMAIL_FROM: 'f' };
        const b = await sendAlert(turnAlertText(ev), { env, fetchImpl: async () => ({ ok: false, status: 422 }), log: (l) => logs.push(l) });
        expect(b).toEqual({ sent: false, reason: 'resend-422' });
        expect(logs.filter((l) => /NOT sent/.test(l))).toHaveLength(2);
    });

    it('the unreadable-usage alert says why and what to check', () => {
        const t = turnAlertText({ kind: 'turn-usage-unknown', error: 'Cloudflare analytics API 403', capBytes: 20 * GB }, 'p');
        expect(t.subject).toMatch(/cannot be read/);
        expect(t.text).toMatch(/403/);
        expect(t.text).toMatch(/TURN_ANALYTICS_API_TOKEN/);
    });
});

describe('turn-credentials over the socket when the cap is reached', () => {
    it('answers 429 with its code and retry_after_ms', async () => {
        const { startTestServer, stopTestServer, connectClient } = await import('./helpers.mjs');
        const { setTurnIssuer } = require('../server');
        const { url } = await startTestServer();
        try {
            const { usage } = make(() => usageReply(25 * GB));
            await usage.refresh();
            setTurnIssuer(createTurnIssuer({ keyId: 'key1', apiToken: 't', fetchImpl: async () => { throw new Error('must not be called'); }, usage }));
            const { webcrypto, createPrivateKey, sign: nodeSign } = await import('crypto');
            const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
            const pub = await webcrypto.subtle.exportKey('jwk', kp.publicKey);
            const key = createPrivateKey({ key: await webcrypto.subtle.exportKey('jwk', kp.privateKey), format: 'jwk' });
            const publickey = JSON.stringify({ kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y });
            const canon = (o) => (typeof o !== 'object' || o === null) ? JSON.stringify(o) : '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
            const sig = (d) => nodeSign('sha256', Buffer.from(canon(d)), { key, dsaEncoding: 'ieee-p1363' }).toString('base64');
            const client = await connectClient(url);
            const idData = { op: 'identify', publickey, token: client.token, ts: Date.now() };
            client.send({ type: 'identify', data: idData, signature: sig(idData), id: 'i1' });
            await client.waitFor((m) => m.type === 'identified');
            const data = { op: 'turn-credentials', publickey, ts: Date.now() };
            client.send({ type: 'turn-credentials', data, signature: sig(data), id: 't1' });
            const res = await client.waitFor((m) => m.id === 't1');
            expect(res).toMatchObject({ type: 'error', status: 429, code: 'turn-daily-cap' });
            expect(res.retry_after_ms).toBeGreaterThan(0);
            await client.close();
        } finally {
            setTurnIssuer(createTurnIssuer({ keyId: '', apiToken: '' }));
            await stopTestServer();
        }
    });
});
