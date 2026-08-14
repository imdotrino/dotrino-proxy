/**
 * Registro de proxies peer: quién es cada nodo de la malla y cómo se le habla.
 *
 * Antes de la fase 1 no había registro: `PROXY_PEERS` era una lista de URLs y la
 * autenticación un secreto simétrico compartido. Eso tenía dos agujeros: quien
 * tuviera el secreto podía hablar EN NOMBRE de cualquier nodo, y no había forma
 * de saber a qué nodo pertenece un identificador.
 *
 * Ahora cada nodo publica `GET /node` con un anuncio AUTOFIRMADO
 * (`{body:{v,nodeId,pubkey,url,ts}, signature}`) y este registro lo PINEA la
 * primera vez que lo ve. A partir de ahí:
 *   - una trama s2s solo se acepta si viene firmada por la pubkey pineada;
 *   - el id de nodo se VERIFICA contra la llave (se deriva de ella), así que
 *     nadie puede anunciar el id de otro sin su llave privada. Eso es lo que
 *     hace que no haga falta que nadie "admita" un nodo nuevo;
 *   - si un URL cambia de pubkey, NO se resuelve solo: se rechaza y se grita en
 *     el log, porque un cambio legítimo de llave es justo cuando el operador
 *     quiere enterarse.
 *
 * El pineo es confianza-al-primer-uso. Es suficiente entre nodos propios; para
 * terceros, la fuente de verdad es el directorio firmado (nodes.json), que gana
 * sobre el TOFU cuando trae una entrada para ese URL.
 */
const { verifyBody, isValidNodeId, nodeIdMatches, hintOf, signBody, newNonce } = require('./nodeIdentity');

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
        this.byUrl = new Map();     // url    -> {url, pubkey, nodeId}
        this.byPubkey = new Map();  // pubkey -> {url, pubkey, nodeId}
        this.byId = new Map();      // nodeId -> {url, pubkey, nodeId}
        // hint (2 chars) -> Set de peers. Es un Set y no un valor porque el
        // filtro PUEDE repetirse entre nodos: no es un reclamo exclusivo.
        this.byHint = new Map();
        this.refreshTimer = null;
    }

    /**
     * La identidad se conoce DESPUÉS de construir el registro: leerla exige
     * descifrar el archivo del vault, que es asíncrono (ver `nodeIdentity.js`).
     * Se fija antes de arrancar la federación, nunca en caliente.
     */
    setIdentity(identity) { this.identity = identity; }

    /**
     * Rehidrata desde SQLite lo ya pineado. Las filas cuyo id NO se corresponde
     * con su pubkey se DESCARTAN: pueden venir de un esquema viejo donde el id
     * se declaraba en vez de derivarse, y aceptarlas sería seguir confiando en
     * una declaración. Se vuelven a pinear solas en el próximo descubrimiento.
     */
    load() {
        let rows = [];
        try { rows = this.persist.loadPeerNodes(); } catch (_) { rows = []; }
        let ok = 0;
        for (const r of rows) {
            if (!nodeIdMatches(r.node_id, r.pubkey)) {
                try { this.persist.deletePeerNode(r.url); } catch (_) {}
                this.log(`[fed] descartado pineo obsoleto de ${r.url} (su id no se deriva de su llave)`);
                continue;
            }
            this._index({ url: r.url, pubkey: r.pubkey, nodeId: r.node_id });
            ok++;
        }
        return ok;
    }

    _index(peer) {
        this.byUrl.set(peer.url, peer);
        this.byPubkey.set(peer.pubkey, peer);
        this.byId.set(peer.nodeId, peer);
        const h = hintOf(peer.nodeId);
        if (!this.byHint.has(h)) this.byHint.set(h, new Set());
        this.byHint.get(h).add(peer);
    }

    get(url) { return this.byUrl.get(url) || null; }
    byNodePubkey(pubkey) { return this.byPubkey.get(pubkey) || null; }
    byNodeId(nodeId) { return this.byId.get(nodeId) || null; }

    /**
     * Peers cuyo id EMPIEZA con ese filtro. Puede devolver más de uno: el filtro
     * no es exclusivo. En la práctica es uno (con 100 nodos, 1,08 de media).
     */
    candidatesByHint(hint) {
        const set = this.byHint.get(hint);
        return set ? Array.from(set) : [];
    }

    known() { return Array.from(this.byUrl.values()); }

    /** El anuncio autofirmado de ESTE nodo (lo que sirve GET /node). */
    selfAnnouncement(selfUrl) {
        if (!this.identity) return null;
        const body = {
            v: 1,
            nodeId: this.identity.nodeId,
            pubkey: this.identity.pubkey,
            url: selfUrl || null,
            ts: Date.now(),
            nonce: newNonce()
        };
        return { body, signature: signBody(this.identity, body) };
    }

    /**
     * Valida un anuncio recibido: firmado por la pubkey que declara, fresco y con
     * id bien formado Y derivado de su llave. Devuelve {url,pubkey,nodeId} o null.
     */
    static parseAnnouncement(announcement, url) {
        const body = announcement && announcement.body;
        const sig = announcement && announcement.signature;
        if (!body || !sig || body.v !== 1) return null;
        if (!body.pubkey || !isValidNodeId(body.nodeId)) return null;
        if (!Number.isFinite(body.ts) || Math.abs(Date.now() - body.ts) > ANNOUNCE_TS_TOLERANCE_MS) return null;
        // AUTOfirmado: prueba que quien contesta tiene la llave privada de esa
        // pubkey, o sea que no puede anunciar la pubkey de otro.
        if (!verifyBody(body, sig, body.pubkey)) return null;
        // Y EL ID SE VERIFICA CONTRA LA LLAVE. Sin esto el id sería una simple
        // declaración —se lo quedaba el primero que lo dijera— y haría falta que
        // alguien la validara. Con esto, usar el id de otro exige su llave
        // privada, y por eso no hay nada que "la red" tenga que admitir.
        if (!nodeIdMatches(body.nodeId, body.pubkey)) return null;
        return { url, pubkey: body.pubkey, nodeId: body.nodeId };
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
            try { this.persist.touchPeerNode(peer.url, Date.now()); } catch (_) {}
            return { status: 'known', peer: existing };
        }
        // Ya no hay conflicto de "id tomado": el id se deriva de la llave, así que
        // dos ids iguales significan la MISMA llave. Lo que sí se comprueba es que
        // el mismo nodo no aparezca bajo dos URLs distintas, porque entonces no se
        // sabría a cuál hablarle.
        const sameId = this.byId.get(peer.nodeId);
        if (sameId && sameId.url !== peer.url) {
            return { status: 'conflict', reason: `el nodo ${peer.nodeId} ya está pineado en ${sameId.url}; ${peer.url} anuncia la misma llave` };
        }
        if (this.identity && peer.nodeId === this.identity.nodeId) {
            return { status: 'conflict', reason: `el peer ${peer.url} anuncia MI propia llave` };
        }
        try { this.persist.pinPeerNode(peer.url, peer.pubkey, peer.nodeId, Date.now()); } catch (e) {
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
            if (r.status === 'pinned') this.log(`[fed] peer pineado: ${url} (id ${r.peer.nodeId})`);
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
