/**
 * Malla s2s: un WebSocket persistente por peer, en vez de un POST por mensaje.
 *
 * Por qué se cambia `POST /federate` (que sigue existiendo como reserva):
 *
 *  1. ORDEN Y PÉRDIDA. El forward era `fetch` sin `await`, sin reintento y sin
 *     numeración. Mientras la federación era un camino frío para la cola offline
 *     daba igual; en cuanto por ahí pasa tráfico de tiempo real (una partida, la
 *     señalización WebRTC), degrada a transporte desordenado y con pérdida algo
 *     que dentro de un nodo viaja ordenado y fiable por TCP.
 *  2. NAT. Un POST exige que el peer sea alcanzable DESDE FUERA, así que un nodo
 *     autohospedado detrás de un router doméstico no podía federar nunca. Acá el
 *     nodo DISCA hacia afuera, que es lo que sí puede hacer.
 *  3. COSTE. Un handshake TLS + una verificación ECDSA por mensaje se convierten
 *     en un handshake por CONEXIÓN: la sesión se autentica una vez con un reto
 *     fresco y después el socket ya está probado.
 *
 * Topología: cada nodo DISCA a cada peer, así que entre dos nodos hay dos
 * sockets y cada uno manda por el suyo. Es un socket de más y a cambio no hay
 * que resolver quién gana cuando los dos discan a la vez.
 *
 * Autenticación: el que recibe manda un reto; el que disca lo firma con la llave
 * del nodo (`nodeIdentity`) y el receptor verifica contra la pubkey PINEADA de
 * ese peer (`peers.js`). El reto fresco por conexión es lo que cierra el replay,
 * sin tener que firmar cada trama.
 */
const WebSocket = require('ws');
const { signBody, verifyBody, newNonce } = require('./nodeIdentity');

const S2S_PATH = '/_s2s';
const HELLO_TIMEOUT_MS = 10000;
const HEARTBEAT_MS = 30000;
const RETAIN_MAX = 500;          // tramas sin acuse que se guardan para reenviar
const BACKOFF_MIN_MS = 500;
// Tope BAJO a propósito: el caso normal de un peer caído no es "se murió una
// semana", es un deploy — vuelve en segundos. Con un tope de 30 s el enlace se
// quedaba esperando medio minuto después de que el peer ya estaba arriba, y todo
// lo pendiente se entregaba tarde sin razón.
const BACKOFF_MAX_MS = 10000;

/** Conexión SALIENTE hacia un peer. Reconecta sola y reenvía lo no acusado. */
class MeshLink {
    constructor({ url, identity, registry, onFrame, log = () => {} }) {
        this.url = url;
        this.identity = identity;
        this.registry = registry;
        this.onFrame = onFrame;
        this.log = log;
        this.ws = null;
        this.ready = false;
        this.seq = 0;
        this.retain = new Map();   // seq -> frame pendiente de acuse
        this.backoff = BACKOFF_MIN_MS;
        this.stopped = false;
        this.timers = new Set();
        this.stats = { sent: 0, acked: 0, resent: 0, reconnects: 0 };
    }

    _timer(fn, ms) {
        const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
        if (t.unref) t.unref();
        this.timers.add(t);
        return t;
    }

    /** URL WebSocket del peer a partir de su URL HTTP. */
    wsUrl() {
        return this.url.replace(/^http/, 'ws') + S2S_PATH;
    }

    start() {
        this.stopped = false;
        this._connect();
    }

    stop() {
        this.stopped = true;
        for (const t of this.timers) clearTimeout(t);
        this.timers.clear();
        if (this.ws) { try { this.ws.close(); } catch (_) {} }
        this.ws = null;
        this.ready = false;
    }

    _connect() {
        if (this.stopped || !this.identity) return;
        let ws;
        try { ws = new WebSocket(this.wsUrl(), { handshakeTimeout: HELLO_TIMEOUT_MS }); }
        catch (e) { this._scheduleReconnect(); return; }
        this.ws = ws;

        const helloTimer = this._timer(() => {
            if (!this.ready) { try { ws.close(); } catch (_) {} }
        }, HELLO_TIMEOUT_MS);

        ws.on('message', (raw) => {
            let f; try { f = JSON.parse(raw.toString()); } catch (_) { return; }
            if (f.t === 'challenge') {
                const body = { v: 1, op: 's2s-hello', from: this.identity.pubkey, prefix: this.identity.prefix, nonce: f.nonce, ts: Date.now() };
                this._raw({ t: 'hello', body, signature: signBody(this.identity, body) });
                return;
            }
            if (f.t === 'ready') {
                clearTimeout(helloTimer);
                this.ready = true;
                this.backoff = BACKOFF_MIN_MS;
                this.log(`[mesh] enlace listo con ${this.url} (prefijo ${f.prefix || '?'})`);
                this._flush();
                return;
            }
            if (f.t === 'ack') { this._onAck(f.seq); return; }
            if (f.t === 'msg') { this.onFrame(f, this); return; }
        });

        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('close', () => { this.ready = false; this._scheduleReconnect(); });
        ws.on('error', () => { /* el close que sigue agenda la reconexión */ });

        const beat = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (ws.isAlive === false) { try { ws.terminate(); } catch (_) {} return; }
            ws.isAlive = false;
            try { ws.ping(); } catch (_) {}
        }, HEARTBEAT_MS);
        if (beat.unref) beat.unref();
        ws.on('close', () => clearInterval(beat));
    }

    _scheduleReconnect() {
        if (this.stopped) return;
        this.stats.reconnects++;
        // Jitter ±25%: sin él, N nodos que pierden al mismo peer reintentan todos
        // en el mismo milisegundo y le pegan en manada justo al arrancar.
        const jitter = 0.75 + Math.random() * 0.5;
        const delay = Math.round(this.backoff * jitter);
        this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
        this._timer(() => this._connect(), delay);
    }

    _raw(obj) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        try { this.ws.send(JSON.stringify(obj)); return true; } catch (_) { return false; }
    }

    _onAck(seq) {
        if (this.retain.delete(seq)) this.stats.acked++;
    }

    /** Reenvía lo que quedó sin acuse tras una reconexión. */
    _flush() {
        for (const frame of this.retain.values()) {
            if (this._raw(frame)) this.stats.resent++;
        }
    }

    /**
     * Encola una operación hacia el peer. Si el enlace está caído, se guarda y
     * sale en cuanto vuelve (hasta RETAIN_MAX; más allá se tira lo más viejo,
     * que es preferible a crecer sin límite con un peer muerto).
     */
    send(op, payload) {
        const seq = ++this.seq;
        const frame = { t: 'msg', seq, op, payload };
        if (this.retain.size >= RETAIN_MAX) {
            const oldest = this.retain.keys().next().value;
            this.retain.delete(oldest);
        }
        this.retain.set(seq, frame);
        this.stats.sent++;
        if (this.ready) this._raw(frame);
        return seq;
    }

    /** Aviso de baja limpia: el peer deja de rutear hacia acá de inmediato. */
    sayBye(reason = 'shutdown') {
        return this._raw({ t: 'bye', reason });
    }

    pendingCount() { return this.retain.size; }
}

/** La malla completa: enlaces salientes + atención de los entrantes. */
class Mesh {
    constructor({ urls = [], identity = null, registry, onDeliver, log = console.log } = {}) {
        this.identity = identity;
        this.registry = registry;
        this.onDeliver = onDeliver;
        this.log = log;
        this.links = new Map();     // url -> MeshLink
        this.inbound = new Map();   // pubkey del peer -> ws entrante
        for (const url of urls) {
            this.links.set(url, new MeshLink({
                url, identity, registry, log,
                onFrame: (f, link) => this._handleFrame(f, link)
            }));
        }
    }

    start() { for (const l of this.links.values()) l.start(); }

    stop() {
        for (const l of this.links.values()) l.stop();
        for (const ws of this.inbound.values()) { try { ws.close(); } catch (_) {} }
        this.inbound.clear();
    }

    /** ¿Hay al menos un enlace saliente vivo? */
    anyReady() {
        for (const l of this.links.values()) if (l.ready) return true;
        return false;
    }

    /** ¿Hay enlaces configurados? (aunque estén caídos: guardan y reenvían) */
    hasLinks() { return this.links.size > 0; }

    /**
     * Manda una entrega a todos los peers por la malla. Devuelve cuántos enlaces
     * la aceptaron EN VIVO (los caídos la guardan para cuando vuelvan).
     */
    broadcastDeliver(payload) {
        let live = 0;
        for (const l of this.links.values()) {
            l.send('deliver', payload);
            if (l.ready) live++;
        }
        return live;
    }

    _handleFrame(frame, link) {
        if (frame.op === 'deliver') this.onDeliver(frame.payload, link);
    }

    /** ¿Es una conexión entrante de la malla? */
    static isMeshPath(url) {
        return typeof url === 'string' && url.split('?')[0] === S2S_PATH;
    }

    /**
     * Atiende un WebSocket ENTRANTE de otro nodo: reto → hello firmado →
     * verificación contra la pubkey pineada → ready. Mientras no complete el
     * handshake no se procesa ninguna otra trama.
     */
    handleInbound(ws) {
        if (!this.identity) { try { ws.close(1011, 'nodo sin identidad'); } catch (_) {} return; }
        const nonce = newNonce();
        let peer = null;

        const timer = setTimeout(() => {
            if (!peer) { try { ws.close(1008, 'handshake s2s sin completar'); } catch (_) {} }
        }, HELLO_TIMEOUT_MS);
        if (timer.unref) timer.unref();

        const send = (o) => { try { ws.send(JSON.stringify(o)); } catch (_) {} };
        send({ t: 'challenge', nonce });

        ws.on('message', (raw) => {
            let f; try { f = JSON.parse(raw.toString()); } catch (_) { return; }

            if (!peer) {
                if (f.t !== 'hello') return;
                const body = f.body;
                if (!body || body.v !== 1 || body.nonce !== nonce || !body.from) {
                    try { ws.close(1008, 'hello s2s inválido'); } catch (_) {}
                    return;
                }
                const known = this.registry.byNodePubkey(body.from);
                if (!known) {
                    this.log(`[mesh] rechazado: nodo entrante desconocido (no pineado)`);
                    try { ws.close(1008, 'nodo desconocido'); } catch (_) {}
                    return;
                }
                if (!verifyBody(body, f.signature, known.pubkey)) {
                    this.log(`[mesh] rechazado: firma de hello inválida de ${known.url}`);
                    try { ws.close(1008, 'firma inválida'); } catch (_) {}
                    return;
                }
                clearTimeout(timer);
                peer = known;
                // Un peer, una sesión entrante: si reconecta, la vieja sobra.
                const prev = this.inbound.get(known.pubkey);
                if (prev && prev !== ws) { try { prev.close(1000, 'reemplazada'); } catch (_) {} }
                this.inbound.set(known.pubkey, ws);
                ws.meshPeer = known;
                send({ t: 'ready', prefix: this.identity.prefix });
                this.log(`[mesh] enlace entrante aceptado de ${known.url} (prefijo ${known.prefix})`);
                return;
            }

            if (f.t === 'bye') { try { ws.close(1000, 'bye'); } catch (_) {} return; }
            if (f.t !== 'msg' || typeof f.seq !== 'number') return;
            // El acuse va SIEMPRE, incluso si la entrega no encuentra a nadie: es
            // acuse de recepción del nodo, no de entrega al usuario. Si no, el
            // emisor reenviaría para siempre algo que ya llegó.
            try { this._handleFrame(f, null); } finally { send({ t: 'ack', seq: f.seq }); }
        });

        ws.on('close', () => {
            clearTimeout(timer);
            if (peer && this.inbound.get(peer.pubkey) === ws) this.inbound.delete(peer.pubkey);
        });
        ws.on('error', () => {});
    }

    /** Avisa la baja a todos los peers (apagado limpio). */
    sayGoodbye() {
        for (const l of this.links.values()) l.sayBye();
    }

    stats() {
        const out = {};
        for (const [url, l] of this.links) {
            out[url] = { ready: l.ready, pending: l.pendingCount(), ...l.stats };
        }
        return out;
    }
}

module.exports = { Mesh, MeshLink, S2S_PATH };
