/**
 * Emisor de credenciales TURN temporales (Cloudflare Realtime TURN).
 *
 * El proxy es el "TURN admin" del ecosistema: guarda el API token de
 * Cloudflare en el servidor y entrega credenciales EFÍMERAS (TTL corto)
 * solo a conexiones identificadas (pubkey del vault). Así el TURN de
 * Cloudflare solo lo usan apps Dotrino y no tráfico arbitrario:
 *   - la llave de Cloudflare nunca sale del servidor;
 *   - cada credencial expira sola (TTL), no sirve como relay permanente;
 *   - cuota por pubkey/hora contra farmeo de credenciales;
 *   - cache por pubkey para no golpear la API de Cloudflare en cada peer.
 *
 * Config por .env (apagado si faltan las llaves → el cliente cae a STUN-only):
 *   TURN_KEY_ID            id de la TURN key de Cloudflare
 *   TURN_KEY_API_TOKEN     API token de esa TURN key
 *   TURN_TTL_SECONDS       vida de cada credencial (default 600, 60..86400)
 *   TURN_MAX_PER_HOUR      emisiones por pubkey/hora (default 12)
 *   TURN_API_BASE          override del endpoint (tests)
 */

const DEFAULT_TTL_S = 600;
const DEFAULT_MAX_PER_HOUR = 12;
const DEFAULT_API_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const HOUR_MS = 60 * 60 * 1000;

function clampTtl(n) {
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_S;
    return Math.min(86400, Math.max(60, Math.floor(n)));
}

function createTurnIssuer(opts = {}) {
    const keyId = opts.keyId ?? process.env.TURN_KEY_ID ?? '';
    const apiToken = opts.apiToken ?? process.env.TURN_KEY_API_TOKEN ?? '';
    const ttlSeconds = clampTtl(Number(opts.ttlSeconds ?? process.env.TURN_TTL_SECONDS));
    const maxPerHour = Number(opts.maxPerHour ?? process.env.TURN_MAX_PER_HOUR) || DEFAULT_MAX_PER_HOUR;
    const apiBase = (opts.apiBase ?? process.env.TURN_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);

    const enabled = Boolean(keyId && apiToken && fetchImpl);

    // pubkey -> { iceServers, expiresAt } (se reusa hasta ~75% del TTL)
    const cache = new Map();
    // pubkey -> [timestamps de emisión en la última hora]
    const issued = new Map();
    // pubkey -> Promise en vuelo (colapsa pedidos concurrentes de la misma pubkey)
    const inFlight = new Map();

    function pruneIssued(pubkey, now) {
        const list = issued.get(pubkey);
        if (!list) return [];
        const fresh = list.filter((t) => now - t < HOUR_MS);
        if (fresh.length) issued.set(pubkey, fresh);
        else issued.delete(pubkey);
        return fresh;
    }

    // Normaliza la respuesta de Cloudflare ({iceServers:{urls,username,credential}})
    // a un array estándar de RTCIceServer.
    function normalizeIceServers(body) {
        const ice = body && body.iceServers;
        if (!ice) return null;
        const list = Array.isArray(ice) ? ice : [ice];
        const out = list
            .filter((s) => s && s.urls)
            .map((s) => ({
                urls: s.urls,
                ...(s.username ? { username: s.username } : {}),
                ...(s.credential ? { credential: s.credential } : {})
            }));
        return out.length ? out : null;
    }

    async function requestFromCloudflare() {
        const res = await fetchImpl(`${apiBase}/${keyId}/credentials/generate`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ttl: ttlSeconds })
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Cloudflare TURN API ${res.status}: ${text.slice(0, 200)}`);
        }
        const body = await res.json();
        const iceServers = normalizeIceServers(body);
        if (!iceServers) throw new Error('Cloudflare TURN API: respuesta sin iceServers');
        return iceServers;
    }

    /**
     * Emite (o reusa de cache) credenciales para una pubkey identificada.
     * @returns {Promise<{iceServers:any[], expiresAt:number, ttl:number}
     *                   |{limited:true, retry_after_ms:number}>}
     */
    async function issue(pubkey) {
        const now = Date.now();

        const cached = cache.get(pubkey);
        if (cached && now < cached.expiresAt - ttlSeconds * 250) {
            // expiresAt - 25% del TTL: se renueva con margen antes de vencer
            return { iceServers: cached.iceServers, expiresAt: cached.expiresAt, ttl: ttlSeconds };
        }
        cache.delete(pubkey);

        const pending = inFlight.get(pubkey);
        if (pending) return pending;

        const recent = pruneIssued(pubkey, now);
        if (recent.length >= maxPerHour) {
            const retry_after_ms = Math.max(1000, recent[0] + HOUR_MS - now);
            return { limited: true, retry_after_ms };
        }

        const p = (async () => {
            const iceServers = await requestFromCloudflare();
            const expiresAt = Date.now() + ttlSeconds * 1000;
            cache.set(pubkey, { iceServers, expiresAt });
            recent.push(Date.now());
            issued.set(pubkey, recent);
            return { iceServers, expiresAt, ttl: ttlSeconds };
        })().finally(() => inFlight.delete(pubkey));
        inFlight.set(pubkey, p);
        return p;
    }

    function destroy() {
        cache.clear();
        issued.clear();
        inFlight.clear();
    }

    return { enabled, ttlSeconds, maxPerHour, issue, destroy };
}

module.exports = { createTurnIssuer };
