/**
 * apns.js — timbre por Apple Push Notification service para las apps nativas de iOS.
 *
 * Hermano de `fcm.js`: el MISMO timbre sin contenido (`{ type: 'ring' }`). Apple no ve ni
 * siquiera el texto: la alerta va con `loc-key`, así que la frase («Tienes mensajes nuevos»)
 * la pone el propio teléfono desde el `Localizable.strings` de la app. Cada app que quiera
 * timbre declara esas dos claves: `DOTRINO_RING_TITLE` y `DOTRINO_RING_BODY`.
 *
 * No es un push silencioso (`content-available`): iOS los raciona y no los entrega si el
 * usuario cerró la app, que es justo cuando hace falta el timbre.
 *
 * La llave llega por variables, como cualquier otra (del .env o del cajón `proxy`):
 *   APNS_KEY_B64   la `.p8` en base64 (una línea)
 *   APNS_KEY_ID    su Key ID (10 caracteres)
 *   APNS_TEAM_ID   el equipo (P7G853375S)
 * Una sola llave sirve para todas las apps del equipo: cada suscripción dice su `topic`
 * (el bundle id) y su entorno (`sandbox` en las builds de Xcode, `production` en
 * TestFlight y App Store). Sin librerías: un JWT ES256 con `node:crypto` y `node:http2`.
 */
const crypto = require('node:crypto');
const http2 = require('node:http2');

const HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function loadKey() {
    const raw = process.env.APNS_KEY_B64 || '';
    const keyId = process.env.APNS_KEY_ID || '';
    const teamId = process.env.APNS_TEAM_ID || '';
    if (!raw || !keyId || !teamId) return null;
    try {
        const pem = Buffer.from(raw, 'base64').toString('utf8');
        return { key: crypto.createPrivateKey(pem), keyId, teamId };
    } catch (_) { return null; }
}

// Apple rechaza un JWT de más de una hora y también uno renovado más de una vez cada 20
// minutos: se reusa 50 minutos.
let cached = { jwt: null, at: 0 };
function providerToken(k) {
    if (cached.jwt && Date.now() - cached.at < 50 * 60 * 1000) return cached.jwt;
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: k.keyId }));
    const claims = b64url(JSON.stringify({ iss: k.teamId, iat: Math.floor(Date.now() / 1000) }));
    const sig = crypto.sign('sha256', Buffer.from(header + '.' + claims), { key: k.key, dsaEncoding: 'ieee-p1363' });
    cached = { jwt: header + '.' + claims + '.' + b64url(sig), at: Date.now() };
    return cached.jwt;
}

// Una conexión HTTP/2 por entorno, reusada (Apple pide no abrir una por timbre).
const sessions = {};
function session(env) {
    const s = sessions[env];
    if (s && !s.closed && !s.destroyed) return s;
    const n = http2.connect(HOSTS[env]);
    n.on('error', () => {});
    n.on('close', () => { if (sessions[env] === n) delete sessions[env]; });
    n.setTimeout(10 * 60 * 1000, () => n.close());
    sessions[env] = n;
    return n;
}

// EL TRINO: uno de siete al azar. Los archivos los instala `DotrinoPush` (dotrino-native) en
// `Library/Sounds` de cada app; si a una le faltan, iOS usa el sonido por defecto. Si cambia el
// número, cambia también `DotrinoPush.ringCount`.
const RINGS = 7;
const ringName = () => `dotrino-ring-${1 + crypto.randomInt(RINGS)}.caf`;

/**
 * Lo que Apple recibe: una alerta localizada en el teléfono y el timbre, nada más.
 *
 * `mutable-content: 1` deja que la extensión de notificaciones de la app (si la tiene) baje el
 * pedido ella misma y reescriba el texto con el PORQUÉ («proxy1 pide sus claves»). Apple sigue
 * sin ver nada: el motivo se busca en el teléfono, sellado, y aquí no viaja. Sin extensión, iOS
 * enseña la alerta de siempre.
 */
function apnsBody(payload) {
    return JSON.stringify({
        aps: { alert: { 'title-loc-key': 'DOTRINO_RING_TITLE', 'loc-key': 'DOTRINO_RING_BODY' }, sound: ringName(), 'mutable-content': 1 },
        ...(payload || {}),
    });
}

/**
 * Manda el timbre a un token de APNs. Devuelve `{ ok }`, `{ ok:false, disabled:true }` sin
 * llave, o `{ ok:false, gone:true }` si el token ya no vale (la app se desinstaló, o es de
 * otro entorno): el llamante borra la suscripción.
 */
function ringApns(sub, payload) {
    const k = loadKey();
    if (!k) return Promise.resolve({ ok: false, disabled: true });
    const env = sub.env === 'sandbox' ? 'sandbox' : 'production';
    return new Promise((resolve) => {
        let req;
        try {
            req = session(env).request({
                ':method': 'POST',
                ':path': '/3/device/' + sub.token,
                authorization: 'bearer ' + providerToken(k),
                'apns-topic': sub.topic,
                'apns-push-type': 'alert',
                'apns-priority': '10',
                'apns-expiration': String(Math.floor(Date.now() / 1000) + 86400),
                // Varios timbres seguidos se funden en una sola alerta.
                'apns-collapse-id': 'dotrino-ring',
                'content-type': 'application/json',
            });
        } catch (e) { resolve({ ok: false, status: 0, body: e.message }); return; }
        let status = 0, body = '';
        req.setEncoding('utf8');
        req.on('response', (h) => { status = h[':status']; });
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            if (status === 200) return resolve({ ok: true });
            const gone = status === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(body);
            resolve({ ok: false, gone, status, body: body.slice(0, 200) });
        });
        req.on('error', (e) => resolve({ ok: false, status, body: e.message }));
        req.setTimeout(15000, () => { req.close(); resolve({ ok: false, status, body: 'timeout' }); });
        req.end(apnsBody(payload));
    });
}

/** `{ kind:'apns', token, topic, env }` bien formada, o null. */
function parseApnsSubscription(s) {
    if (!s || s.kind !== 'apns') return null;
    if (typeof s.token !== 'string' || !/^[0-9a-f]{64,200}$/i.test(s.token)) return null;
    if (typeof s.topic !== 'string' || !/^com\.dotrino\.[a-z0-9.-]{1,80}$/i.test(s.topic)) return null;
    if (s.env !== 'sandbox' && s.env !== 'production') return null;
    return { kind: 'apns', token: s.token.toLowerCase(), topic: s.topic, env: s.env };
}

module.exports = { ringApns, apnsEnabled: () => !!loadKey(), parseApnsSubscription, _apnsBody: apnsBody, _providerToken: providerToken };
