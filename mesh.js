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

/**
 * Límite por PEER de las operaciones que llegan por la malla.
 *
 * El rate limiter del proxy se cobra en un único sitio: el bucle de mensajes de
 * los clientes WebSocket. Todo lo que entra por s2s lo esquivaba por completo,
 * así que un nodo peer podía canjear citas a velocidad de cable y saltarse
 * cualquier límite puesto del lado del cliente. Como la cita es el código corto
 * que una persona comparte, eso convertía a un solo peer en una cosechadora.
 *
 * Los peers están pineados, así que esto no defiende de desconocidos: defiende
 * de un peer comprometido o mal intencionado, y acota el daño de un bug ajeno.
 * Al pasarse NO se corta el enlace —eso dejaría que una operación tonta rompa
 * toda la federación—: se descarta la trama y se cuenta.
 */
const S2S_LIMITS = {
    // Tráfico normal entre usuarios de nodos distintos: generoso, es agregado
    // de TODOS los usuarios de ese peer.
    relay:         { burst: 600, ratePerSec: 300 },
    deliver:       { burst: 600, ratePerSec: 300 },
    'chan-op':     { burst: 200, ratePerSec: 50 },
    'chan-result': { burst: 200, ratePerSec: 50 },
    'chan-event':  { burst: 400, ratePerSec: 200 },
    'peer-gone':   { burst: 200, ratePerSec: 50 },
    // ESTRICTO: canjear una cita es un acto humano, no de máquina. Ni el peer
    // más ocupado necesita más de unos pocos por segundo.
    'pair-redeem': { burst: 20, ratePerSec: 2 },
    'pair-result': { burst: 20, ratePerSec: 2 },
    __default__:   { burst: 100, ratePerSec: 25 }
};

function s2sLimitFor(op) {
    const envBurst = Number.parseInt(process.env[`S2S_LIMIT_${String(op).toUpperCase().replace(/-/g, '_')}_BURST`] || '', 10);
    const envRate = Number.parseFloat(process.env[`S2S_LIMIT_${String(op).toUpperCase().replace(/-/g, '_')}_RATE`] || '');
    const base = S2S_LIMITS[op] || S2S_LIMITS.__default__;
    return {
        burst: Number.isFinite(envBurst) && envBurst > 0 ? envBurst : base.burst,
        ratePerSec: Number.isFinite(envRate) && envRate > 0 ? envRate : base.ratePerSec
    };
}

/** Cubetas por operación para UN peer. */
class PeerBuckets {
    constructor(now = Date.now()) { this.buckets = new Map(); this.dropped = 0; this.now = now; }

    allow(op, now = Date.now()) {
        let b = this.buckets.get(op);
        if (!b) {
            const { burst, ratePerSec } = s2sLimitFor(op);
            b = { tokens: burst, burst, ratePerSec, last: now };
            this.buckets.set(op, b);
        }
        const elapsed = Math.max(0, (now - b.last) / 1000);
        b.last = now;
        b.tokens = Math.min(b.burst, b.tokens + elapsed * b.ratePerSec);
        if (b.tokens < 1) { this.dropped++; return false; }
        b.tokens -= 1;
        return true;
    }
}
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
                const body = { v: 1, op: 's2s-hello', from: this.identity.pubkey, nodeId: this.identity.nodeId, nonce: f.nonce, ts: Date.now() };
                this._raw({ t: 'hello', body, signature: signBody(this.identity, body) });
                return;
            }
            if (f.t === 'ready') {
                clearTimeout(helloTimer);
                this.ready = true;
                this.backoff = BACKOFF_MIN_MS;
                this.log(`[mesh] enlace listo con ${this.url} (id ${f.nodeId || '?'})`);
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
    send(op, payload, { retain = true } = {}) {
        const seq = ++this.seq;
        const frame = { t: 'msg', seq, op, payload };
        // `retain:false` para tráfico efímero: si el enlace está caído no tiene
        // sentido guardarlo, porque para cuando vuelva ya no sirve.
        if (retain) {
            if (this.retain.size >= RETAIN_MAX) {
                const oldest = this.retain.keys().next().value;
                this.retain.delete(oldest);
            }
            this.retain.set(seq, frame);
        }
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
    constructor({ urls = [], identity = null, registry, onDeliver, onRelay, onPeerGone,
                  onPairRedeem, onPairResult, onChanOp, onChanResult, onChanEvent,
                  log = console.log } = {}) {
        this.identity = identity;
        this.registry = registry;
        this.onDeliver = onDeliver;
        this.onRelay = onRelay || (() => {});
        this.onPeerGone = onPeerGone || (() => {});
        this.onPairRedeem = onPairRedeem || (() => {});
        this.onPairResult = onPairResult || (() => {});
        this.onChanOp = onChanOp || (() => {});
        this.onChanResult = onChanResult || (() => {});
        this.onChanEvent = onChanEvent || (() => {});
        this.log = log;
        this.links = new Map();     // url -> MeshLink
        this.inbound = new Map();   // pubkey del peer -> ws entrante
        this.started = false;       // para que `setUrls` sepa si arrancar lo nuevo
        for (const url of urls) {
            this.links.set(url, new MeshLink({
                url, identity, registry, log,
                onFrame: (f, link) => this._handleFrame(f, link)
            }));
        }
    }

    /**
     * La identidad llega después de construir la malla (leerla del vault es
     * asíncrono, ver `nodeIdentity.js`), así que hay que bajarla también a los
     * enlaces: la recibieron por constructor cuando todavía era null y firman
     * con ella. Se llama antes de `start()`, nunca con enlaces vivos.
     */
    setIdentity(identity) {
        this.identity = identity;
        for (const l of this.links.values()) l.identity = identity;
    }

    /**
     * Cambia la lista de peers con la malla ya andando. Existe porque la lista la
     * puede traer la bóveda DESPUÉS del arranque (el proxio nunca la espera, ver
     * `applyFederationConfig` en server.js): el enlace que sobra se cierra, el que
     * falta se crea, y el que ya estaba NO se toca — reconectarlo tiraría las
     * tramas que tiene retenidas esperando acuse.
     */
    setUrls(urls = []) {
        const want = new Set(urls);
        for (const [url, link] of [...this.links]) {
            if (want.has(url)) continue;
            link.stop();
            this.links.delete(url);
        }
        for (const url of urls) {
            if (this.links.has(url)) continue;
            const link = new MeshLink({
                url, identity: this.identity, registry: this.registry, log: this.log,
                onFrame: (f, l) => this._handleFrame(f, l)
            });
            this.links.set(url, link);
            if (this.started) link.start();
        }
    }

    start() { this.started = true; for (const l of this.links.values()) l.start(); }

    stop() {
        this.started = false;
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
    broadcastDeliver(payload, opts = {}) {
        let live = 0;
        for (const l of this.links.values()) {
            l.send('deliver', payload, opts);
            if (l.ready) live++;
        }
        return live;
    }

    _handleFrame(frame, link) {
        if (frame.op === 'deliver') this.onDeliver(frame.payload, link);
        else if (frame.op === 'relay') this.onRelay(frame.payload, link);
        else if (frame.op === 'peer-gone') this.onPeerGone(frame.payload, link);
        else if (frame.op === 'pair-redeem') this.onPairRedeem(frame.payload, link);
        else if (frame.op === 'pair-result') this.onPairResult(frame.payload, link);
        else if (frame.op === 'chan-op') this.onChanOp(frame.payload, link);
        else if (frame.op === 'chan-result') this.onChanResult(frame.payload, link);
        else if (frame.op === 'chan-event') this.onChanEvent(frame.payload, link);
    }

    /** Enlace SALIENTE hacia el nodo con esa pubkey (o null). */
    linkForNode(nodePubkey) {
        const peer = this.registry.byNodePubkey(nodePubkey);
        if (!peer) return null;
        return this.links.get(peer.url) || null;
    }

    /** Manda una operación a UN nodo concreto. Devuelve false si no hay enlace. */
    sendTo(nodePubkey, op, payload, opts = {}) {
        const link = this.linkForNode(nodePubkey);
        if (!link) return false;
        link.send(op, payload, opts);
        return true;
    }

    /**
     * Relay de un mensaje dirigido a una instancia de OTRO nodo.
     *
     * Va con `retain:false` a propósito: el mensaje entre dos conexiones vivas
     * caduca igual que ellas. Si el enlace está caído, guardarlo para entregarlo
     * cuando vuelva significaría soltarlo minutos después, cuando el destinatario
     * probablemente ya no está — y quien envía prefiere enterarse ahora
     * (`failed`) a que llegue tarde y fuera de contexto.
     */
    relayTo(nodePubkey, payload) {
        const link = this.linkForNode(nodePubkey);
        if (!link || !link.ready) return false;
        link.send('relay', payload, { retain: false });
        return true;
    }

    /**
     * Dispara un descubrimiento de peers, como mucho uno cada 2 s. El límite
     * importa: si no, un desconocido insistente nos haría bajar el `/node` de
     * todos los peers en bucle.
     */
    _kickDiscovery() {
        const now = Date.now();
        if (this._lastKick && now - this._lastKick < 2000) return;
        this._lastKick = now;
        if (this.registry && typeof this.registry.discoverAll === 'function') {
            this.registry.discoverAll().catch(() => {});
        }
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
        const buckets = new PeerBuckets();

        const timer = setTimeout(() => {
            if (!peer) { try { ws.close(1008, 'handshake s2s sin completar'); } catch (_) {} }
        }, HELLO_TIMEOUT_MS);
        if (timer.unref) timer.unref();

        const send = (o) => { try { ws.send(JSON.stringify(o)); } catch (_) {} };

        // Canal de RESPUESTA por el mismo socket entrante. Hace falta porque hay
        // operaciones que piden una contestación (el canje de una cita, por
        // ejemplo) y de este lado no hay un MeshLink: solo el socket que abrió el
        // otro. El que discó ya sabe procesar `t:'msg'` que le llegan de vuelta.
        let replySeq = 0;
        const replyChannel = {
            send: (op, payload) => send({ t: 'msg', seq: ++replySeq, op, payload })
        };

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
                    // Que un desconocido toque la puerta es la mejor señal de que
                    // hay que ir a descubrir: casi siempre es un peer configurado
                    // que arrancó después que nosotros y al que no alcanzamos a
                    // pinear. Sin esto había que esperar al refresco periódico, y
                    // durante ese rato la federación quedaba en un solo sentido.
                    this._kickDiscovery();
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
                send({ t: 'ready', nodeId: this.identity.nodeId });
                this.log(`[mesh] enlace entrante aceptado de ${known.url} (id ${known.nodeId})`);
                return;
            }

            if (f.t === 'bye') { try { ws.close(1000, 'bye'); } catch (_) {} return; }
            if (f.t !== 'msg' || typeof f.seq !== 'number') return;

            // Límite por peer y por operación. Se acusa igual la trama descartada:
            // el acuse es de RECEPCIÓN, y si no se acusara el emisor la reenviaría
            // para siempre, convirtiendo el límite en un bucle infinito.
            if (!buckets.allow(f.op)) {
                if (buckets.dropped === 1 || buckets.dropped % 100 === 0) {
                    this.log(`[mesh] límite s2s: descartadas ${buckets.dropped} tramas de ${peer.url} (última: ${f.op})`);
                }
                send({ t: 'ack', seq: f.seq });
                return;
            }

            // El acuse va SIEMPRE, incluso si la entrega no encuentra a nadie: es
            // acuse de recepción del nodo, no de entrega al usuario. Si no, el
            // emisor reenviaría para siempre algo que ya llegó.
            try { this._handleFrame(f, replyChannel); } finally { send({ t: 'ack', seq: f.seq }); }
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
