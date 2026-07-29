/**
 * CITAS de emparejamiento: el código corto que un humano lee, dicta o escanea.
 *
 * Hasta la fase 4 ese código era el MISMO identificador con el que se ruteaba un
 * mensaje. De ahí salían los dos problemas del ecosistema con varios proxios:
 * como dirección global, 4 caracteres no alcanzan (35^4 = 1.500.625, sorteados
 * por cada nodo sin hablar con los demás → el mismo código podía estar vivo en
 * dos nodos y un mensaje podía terminar en la persona equivocada); y como código
 * humano no podía alargarse sin volverse incómodo de dictar.
 *
 * Separando las dos funciones, cada una se puede dimensionar por lo suyo:
 *
 *   - la INSTANCIA (tokenManager.js) es la dirección: larga, nunca se muestra;
 *   - la CITA (esto) es el código humano: corto, y sobre todo EFÍMERO y de UN
 *     SOLO USO, que es lo que de verdad lo hace seguro. Un código permanente de
 *     6 caracteres se barre entero; uno que vive 5 minutos y se quema al usarse,
 *     no: hay que acertarlo mientras está vivo y antes que su dueño.
 *
 * La cita lleva delante un FILTRO de 2 caracteres: los dos primeros del id del
 * nodo que la emitió. NO es un reclamo exclusivo — dos nodos pueden compartirlo
 * sin que importe. Sirve para saber A QUIÉNES preguntarles: quien canjea se
 * queda con los peers cuyo id empiece así, que en la práctica es uno solo (con
 * 100 nodos, 1,08 de media).
 *
 * La diferencia con pregonar a toda la malla —que es como un nodo hostil se
 * queda con emparejamientos ajenos— es que el filtro sale del id DERIVADO de la
 * llave: un nodo no puede contestar por un código cuyo filtro no le corresponde,
 * y eso es verificable por cualquiera. Si aun así contestan dos que sí, se
 * rechaza el canje y se pide otro código: nunca se elige "el primero".
 */
const crypto = require('crypto');
const { ALPHABET: ALLOWED_CHARS, normalize, isUnfortunate } = require('./alphabet');

const CODE_BODY_LEN = 4;                       // + 2 de filtro de nodo = 6
const DEFAULT_TTL_MS = 5 * 60 * 1000;          // 5 minutos
const MAX_TTL_MS = 30 * 60 * 1000;
const MAX_CODES = 10000;

/**
 * Normaliza lo que teclea (o le dictan a) una persona. Además de mayúsculas y de
 * quitar separadores, traduce los caracteres confundibles: quien oye "ese" y
 * teclea `S` obtiene el `5` que de verdad se emitió. Ver alphabet.js.
 */
const normalizeCode = normalize;

class PairingCodes {
    constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
        this.ttlMs = ttlMs;
        this.codes = new Map();          // code -> {instance, pubkey, expiresAt}
        this.byInstance = new Map();     // instance -> code (una cita viva por conexión)
        this.cleanupTimer = null;
    }

    _randomBody() {
        let out = '';
        for (let i = 0; i < CODE_BODY_LEN; i++) out += ALLOWED_CHARS[crypto.randomInt(ALLOWED_CHARS.length)];
        return out;
    }

    /**
     * Cuerpo sorteado que no forme una palabra que dé vergüenza dictar.
     * Se comprueba el código COMPLETO (filtro + cuerpo), no solo el cuerpo: con
     * el filtro `PU` y el cuerpo `TAXX` sale `PUTAXX`, y mirando solo el cuerpo
     * eso pasaba limpio.
     */
    _decentBody(hint) {
        for (let i = 0; i < 20; i++) {
            const body = this._randomBody();
            if (!isUnfortunate(hint + body)) return body;
        }
        return this._randomBody();
    }

    /**
     * Crea (o renueva) la cita de una conexión.
     * @returns {{code:string, expiresAt:number}|null} null si no hay prefijo de nodo.
     */
    create({ instance, pubkey = null, hint, ttlMs }) {
        if (!hint) return null;
        if (this.codes.size >= MAX_CODES) this.cleanup();
        if (this.codes.size >= MAX_CODES) return null;

        // Una cita viva por conexión: pedir otra invalida la anterior, así no
        // quedan códigos sueltos apuntando a la misma persona.
        this.release(instance);

        const ttl = Math.min(Math.max(Number(ttlMs) || this.ttlMs, 30 * 1000), MAX_TTL_MS);
        const expiresAt = Date.now() + ttl;
        let code = null;
        for (let i = 0; i < 50; i++) {
            const candidate = hint + this._decentBody(hint);
            if (!this.codes.has(candidate)) { code = candidate; break; }
        }
        if (!code) return null;

        this.codes.set(code, { instance, pubkey, expiresAt });
        this.byInstance.set(instance, code);
        return { code, expiresAt };
    }

    /**
     * Canjea una cita: devuelve a quién apunta y la QUEMA.
     * Un solo uso: si no, un código que circuló por un grupo de chat sigue
     * sirviendo para colarse después.
     */
    redeem(rawCode) {
        const code = normalizeCode(rawCode);
        if (!code) return { error: 'código vacío' };
        const entry = this.codes.get(code);
        if (!entry) return { error: 'código no válido o ya usado' };
        if (entry.expiresAt <= Date.now()) {
            this.codes.delete(code);
            this.byInstance.delete(entry.instance);
            return { error: 'código caducado' };
        }
        this.codes.delete(code);
        this.byInstance.delete(entry.instance);
        return { instance: entry.instance, pubkey: entry.pubkey };
    }

    /** Mira a quién apunta una cita SIN quemarla (para el nodo dueño). */
    peek(rawCode) {
        const code = normalizeCode(rawCode);
        if (!code) return null;
        const entry = this.codes.get(code);
        if (!entry || entry.expiresAt <= Date.now()) return null;
        return { instance: entry.instance, pubkey: entry.pubkey, expiresAt: entry.expiresAt };
    }

    /** Suelta la cita de una conexión (al desconectarse, o al pedir otra). */
    release(instance) {
        const code = this.byInstance.get(instance);
        if (!code) return false;
        this.codes.delete(code);
        this.byInstance.delete(instance);
        return true;
    }

    cleanup() {
        const now = Date.now();
        let n = 0;
        for (const [code, entry] of this.codes) {
            if (entry.expiresAt <= now) {
                this.codes.delete(code);
                if (this.byInstance.get(entry.instance) === code) this.byInstance.delete(entry.instance);
                n++;
            }
        }
        return n;
    }

    startCleanup(intervalMs = 60 * 1000) {
        this.stopCleanup();
        this.cleanupTimer = setInterval(() => this.cleanup(), intervalMs);
        if (this.cleanupTimer.unref) this.cleanupTimer.unref();
        return this.cleanupTimer;
    }

    stopCleanup() {
        if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
    }

    stats() { return { active: this.codes.size }; }
}

module.exports = { PairingCodes, normalizeCode, ALLOWED_CHARS, CODE_BODY_LEN, DEFAULT_TTL_MS, MAX_TTL_MS };
