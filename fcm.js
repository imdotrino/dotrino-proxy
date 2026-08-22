/**
 * fcm.js — timbre por Firebase Cloud Messaging (HTTP v1) para la app nativa de Dotrino.
 *
 * Es el MISMO timbre sin contenido que Web Push (`{ type: 'ring' }`): solo despierta la
 * app, que baja su cola por el proxio. Google no ve más que «hay algo».
 *
 * La cuenta de servicio llega por `FCM_SERVICE_ACCOUNT_B64` (JSON de Firebase en base64,
 * una línea), como cualquier otra variable: del .env o del cajón `proxy` de la bóveda.
 * Sin ella, el canal queda apagado y se avisa una vez. Sin librerías de Google: un JWT
 * RS256 con `node:crypto` y dos `fetch`.
 */
const crypto = require('node:crypto');

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function loadServiceAccount() {
    const raw = process.env.FCM_SERVICE_ACCOUNT_B64 || '';
    if (!raw) return null;
    try {
        const sa = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
        if (!sa.client_email || !sa.private_key || !sa.project_id) return null;
        return sa;
    } catch (_) { return null; }
}

let cached = { token: null, exp: 0 };
async function accessToken(sa) {
    if (cached.token && Date.now() < cached.exp - 60 * 1000) return cached.token;
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: FCM_SCOPE, aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
    const sig = crypto.sign('sha256', Buffer.from(header + '.' + claims), sa.private_key);
    const assertion = header + '.' + claims + '.' + b64url(sig);
    const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
    });
    if (!res.ok) throw new Error('fcm: token endpoint ' + res.status);
    const j = await res.json();
    cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return cached.token;
}

/**
 * Manda el timbre a un token de FCM. Devuelve `{ ok }` o `{ ok:false, gone:true }` si el
 * token ya no existe (la app se desinstaló): el llamante borra la suscripción.
 */
async function ringFcm(token, payload) {
    const sa = loadServiceAccount();
    if (!sa) return { ok: false, disabled: true };
    const at = await accessToken(sa);
    const data = {};
    for (const [k, v] of Object.entries(payload || {})) data[k] = String(v); // FCM: solo strings
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: 'POST', headers: { authorization: 'Bearer ' + at, 'content-type': 'application/json' },
        body: JSON.stringify({ message: { token, data, android: { priority: 'high', ttl: '86400s' } } })
    });
    if (res.ok) return { ok: true };
    let body = '';
    try { body = await res.text(); } catch (_) {}
    const gone = res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(body);
    return { ok: false, gone, status: res.status, body: body.slice(0, 200) };
}

module.exports = { ringFcm, fcmEnabled: () => !!loadServiceAccount(), _accessToken: accessToken };
