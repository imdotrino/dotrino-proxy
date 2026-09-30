import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { createRequire } from 'module';

// El timbre de iOS: la suscripción se valida, Apple no recibe texto (solo claves que el
// teléfono traduce), y el JWT del proveedor es un ES256 que se verifica con la pública.
const require = createRequire(import.meta.url);
const { parseApnsSubscription, _apnsBody, _providerToken } = require('../apns.js');

const token = 'a'.repeat(64);

describe('apns', () => {
    it('acepta solo suscripciones bien formadas', () => {
        expect(parseApnsSubscription({ kind: 'apns', token: token.toUpperCase(), topic: 'com.dotrino.messenger', env: 'sandbox' }))
            .toEqual({ kind: 'apns', token, topic: 'com.dotrino.messenger', env: 'sandbox' });
        expect(parseApnsSubscription({ kind: 'apns', token, topic: 'com.other.app', env: 'production' })).toBeNull();
        expect(parseApnsSubscription({ kind: 'apns', token: 'xyz', topic: 'com.dotrino.messenger', env: 'production' })).toBeNull();
        expect(parseApnsSubscription({ kind: 'apns', token, topic: 'com.dotrino.messenger', env: 'dev' })).toBeNull();
        expect(parseApnsSubscription({ kind: 'fcm', token })).toBeNull();
    });

    it('la alerta va localizada en el teléfono: ningún texto viaja a Apple', () => {
        const b = JSON.parse(_apnsBody({ type: 'ring', ts: 1 }));
        expect(b.aps.alert).toEqual({ 'title-loc-key': 'DOTRINO_RING_TITLE', 'loc-key': 'DOTRINO_RING_BODY' });
        expect(b.type).toBe('ring');
        expect(b.aps['content-available']).toBeUndefined();
        // Un trino al azar, de los siete que instala DotrinoPush.
        expect(b.aps.sound).toMatch(/^dotrino-ring-[1-7]\.caf$/);
    });

    it('firma el JWT del proveedor con ES256 y el kid/iss correctos', () => {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
        const jwt = _providerToken({ key: privateKey, keyId: 'ABC123DEFG', teamId: 'P7G853375S' });
        const [h, c, s] = jwt.split('.');
        expect(JSON.parse(Buffer.from(h, 'base64url'))).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
        expect(JSON.parse(Buffer.from(c, 'base64url')).iss).toBe('P7G853375S');
        const ok = crypto.verify('sha256', Buffer.from(h + '.' + c), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
        expect(ok).toBe(true);
    });
});

describe('push-subscribe con un token de iOS', () => {
    it('el proxio acepta { kind:"apns" } y rechaza uno mal formado', async () => {
        const fs = await import('fs');
        const { startNode, makeNodeDir, connectIdentified, makeUser, freePort } = await import('./fedHelpers.mjs');
        const dir = makeNodeDir('apns-sub');
        const node = await startNode({ name: 'APNS', dir, port: await freePort() });
        try {
            const user = makeUser();
            const c = await connectIdentified(node.url, user);
            const send = async (subscription) => {
                const data = { op: 'push-subscribe', publickey: user.publickey, ts: Date.now(), subscription: JSON.stringify(subscription) };
                c.recv.length = 0; // waitFor mira también lo ya recibido
                c.send({ type: 'push-subscribe', data, signature: user.sign(data) });
                return c.waitFor((m) => m.type === 'push-subscribed' || m.type === 'error');
            };
            expect((await send({ kind: 'apns', token, topic: 'com.dotrino.messenger', env: 'production' })).type).toBe('push-subscribed');
            expect((await send({ kind: 'apns', token, topic: 'com.evil.app', env: 'production' })).type).toBe('error');
            await c.close();
        } finally {
            await node.stop();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 30000);
});
