/**
 * Registro de proxies peer: quién es cada nodo de la malla y cómo se le habla.
 *
 * Antes de la fase 1 no había registro: `PROXY_PEERS` era una lista de URLs y la
 * autenticación un secreto simétrico compartido. Eso tenía dos agujeros: quien
 * tuviera el secreto podía hablar EN NOMBRE de cualquier nodo, y no había forma
 * de saber a qué nodo pertenece un identificador.
 *
 * Ahora cada nodo publica `GET /node` con un anuncio AUTOFIRMADO
 * (`{body:{v,prefix,pubkey,url,ts}, signature}`) y este registro lo PINEA la
 * primera vez que lo ve. A partir de ahí:
 *   - una trama s2s solo se acepta si viene firmada por la pubkey pineada;
 *   - si un URL cambia de pubkey, o dos nodos reclaman el mismo prefijo, NO se
 *     resuelve solo: se rechaza y se grita en el log. Un takeover silencioso de
 *     prefijo sería secuestrar el espacio de nombres de otro nodo entero.
 *
 * El pineo es confianza-al-primer-uso. Es suficiente entre nodos propios; para
 * terceros, la fuente de verdad es el directorio firmado (nodes.json), que gana
 * sobre el TOFU cuando trae una entrada para ese URL.
 */
const { verifyBody, isValidPrefix, signBody, newNonce } = require('./nodeIdentity');

const ANNOUNCE_TS_TOLERANCE_MS = 5 * 60 * 1000;

class PeerRegistry {
    /**
     * @param {Object} opts
     * @param {string[]} opts.urls          URLs de peers (PROXY_PEERS)
     * @param {Object}   opts.identity      identidad de ESTE nodo (nodeIdentity)
     * @param {Object}   opts.persist       módulo de persistencia (tabla peer_nodes)
     * @param {Function} [opts.log]
     * @param {Function} [opts.fetchImpl]   inyectable para tests
     */
    constructor({ urls = [], identity = null, persist, log = console.log, fetchImpl = fetch } = {}) {
        this.urls = urls;
        this.identity = identity;
        this.persist = persist;
        this.log = log;
        this.fetchImpl = fetchImpl;
        this.byUrl = new Map();     // url    -> {url, pubkey, prefix}
        this.byPubkey = new Map();  // pubkey -> {url, pubkey, prefix}
        this.byPrefix = new Map();  // prefix -> {url, pubkey, prefix}
        this.refreshTimer = null;
    }

    /** Rehidrata desde SQLite lo ya pineado. */
    load() {
        let rows = [];
        try { rows = this.persist.loadPeerNodes(); } catch (_) { rows = []; }
        for (const r of rows) this._index({ url: r.url, pubkey: r.pubkey, prefix: r.prefix });
        return rows.length;
    }

    _index(peer) {
        this.byUrl.set(peer.url, peer);
        this.byPubkey.set(peer.pubkey, peer);
        this.byPrefix.set(peer.prefix, peer);
    }

    get(url) { return this.byUrl.get(url) || null; }
    byNodePubkey(pubkey) { return this.byPubkey.get(pubkey) || null; }
    byNodePrefix(prefix) { return this.byPrefix.get(prefix) || null; }
    known() { return Array.from(this.byUrl.values()); }

    /** El anuncio autofirmado de ESTE nodo (lo que sirve GET /node). */
    selfAnnouncement(selfUrl) {
        if (!this.identity) return null;
        const body = {
            v: 1,
            prefix: this.identity.prefix,
            pubkey: this.identity.pubkey,
            url: selfUrl || null,
            ts: Date.now(),
            nonce: newNonce()
        };
        return { body, signature: signBody(this.identity, body) };
    }

    /**
     * Valida un anuncio recibido: firmado por la pubkey que declara, fresco y con
     * prefijo bien formado. Devuelve {url,pubkey,prefix} o null.
     */
    static parseAnnouncement(announcement, url) {
        const body = announcement && announcement.body;
        const sig = announcement && announcement.signature;
        if (!body || !sig || body.v !== 1) return null;
        if (!body.pubkey || !isValidPrefix(body.prefix)) return null;
        if (!Number.isFinite(body.ts) || Math.abs(Date.now() - body.ts) > ANNOUNCE_TS_TOLERANCE_MS) return null;
        // AUTOfirmado: la firma se verifica con la pubkey que el propio cuerpo
        // declara. Esto NO prueba que sea el nodo que decimos querer (eso lo da el
        // pineo o el directorio); prueba que quien contesta tiene la llave privada
        // de esa pubkey, o sea que no puede anunciar la pubkey de otro.
        if (!verifyBody(body, sig, body.pubkey)) return null;
        return { url, pubkey: body.pubkey, prefix: body.prefix };
    }

    /**
     * Incorpora un peer al registro. Devuelve
     * {status:'pinned'|'known'|'conflict', peer?, reason?}.
     */
    adopt(peer) {
        const existing = this.byUrl.get(peer.url);
        if (existing) {
            if (existing.pubkey !== peer.pubkey) {
                return { status: 'conflict', reason: `el peer ${peer.url} cambió de pubkey; se mantiene la pineada` };
            }
            if (existing.prefix !== peer.prefix) {
                return { status: 'conflict', reason: `el peer ${peer.url} cambió de prefijo (${existing.prefix} → ${peer.prefix}); se mantiene el pineado` };
            }
            try { this.persist.touchPeerNode(peer.url, Date.now()); } catch (_) {}
            return { status: 'known', peer: existing };
        }
        const byPrefix = this.byPrefix.get(peer.prefix);
        if (byPrefix && byPrefix.pubkey !== peer.pubkey) {
            return { status: 'conflict', reason: `el prefijo ${peer.prefix} ya es de ${byPrefix.url}; ${peer.url} no lo puede reclamar` };
        }
        if (this.identity && peer.prefix === this.identity.prefix) {
            return { status: 'conflict', reason: `el peer ${peer.url} reclama MI prefijo (${peer.prefix})` };
        }
        try { this.persist.pinPeerNode(peer.url, peer.pubkey, peer.prefix, Date.now()); } catch (e) {
            return { status: 'conflict', reason: `no se pudo pinear ${peer.url}: ${e.message}` };
        }
        this._index(peer);
        return { status: 'pinned', peer };
    }

    /** Baja el anuncio de un peer y lo adopta. */
    async discover(url) {
        let res;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        try {
            res = await this.fetchImpl(`${url}/node`, { signal: ctrl.signal });
        } catch (e) {
            return { status: 'unreachable', reason: e.message };
        } finally { clearTimeout(t); }
        if (!res.ok) return { status: 'unreachable', reason: `HTTP ${res.status}` };
        let announcement;
        try { announcement = await res.json(); } catch (e) { return { status: 'unreachable', reason: 'respuesta no JSON' }; }
        const peer = PeerRegistry.parseAnnouncement(announcement, url);
        if (!peer) return { status: 'conflict', reason: `anuncio inválido o mal firmado de ${url}` };
        return this.adopt(peer);
    }

    /** Descubre todos los peers configurados (arranque y refresco periódico). */
    async discoverAll() {
        const out = [];
        for (const url of this.urls) {
            const r = await this.discover(url);
            out.push({ url, ...r });
            if (r.status === 'pinned') this.log(`[fed] peer pineado: ${url} (prefijo ${r.peer.prefix})`);
            else if (r.status === 'conflict') this.log(`[fed] CONFLICTO: ${r.reason}`);
            else if (r.status === 'unreachable') this.log(`[fed] peer inalcanzable ${url}: ${r.reason}`);
        }
        return out;
    }

    /** ¿Están pineados todos los peers configurados? */
    allPinned() {
        return this.urls.length > 0 && this.urls.every((u) => this.byUrl.has(u));
    }

    /**
     * Refresco ADAPTATIVO. Mientras falte algún peer por pinear reintenta rápido;
     * cuando ya están todos, pasa al ritmo lento.
     *
     * Con un intervalo fijo largo esto fallaba de forma asimétrica y silenciosa:
     * en un deploy los dos nodos reinician a la vez, el que arranca primero
     * encuentra al otro caído, y hasta el refresco siguiente NO tenía pineado a su
     * peer — así que aceptaba los mensajes del otro pero el otro rechazaba los
     * suyos ("nodo emisor desconocido"). La federación quedaba funcionando en un
     * solo sentido, que es peor que no funcionar, porque no se nota.
     */
    startRefresh({ fastMs = 15 * 1000, slowMs = 10 * 60 * 1000 } = {}) {
        this.stopRefresh();
        const tick = async () => {
            await this.discoverAll().catch(() => {});
            schedule();
        };
        const schedule = () => {
            if (this._stopped) return;
            const delay = this.allPinned() ? slowMs : fastMs;
            this.refreshTimer = setTimeout(tick, delay);
            if (this.refreshTimer.unref) this.refreshTimer.unref();
        };
        this._stopped = false;
        schedule();
        return this.refreshTimer;
    }

    stopRefresh() {
        this._stopped = true;
        if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
    }
}

module.exports = { PeerRegistry, ANNOUNCE_TS_TOLERANCE_MS };
