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
 * La cita lleva delante el PREFIJO DEL NODO que la emitió. Eso hace que sea
 * única en el ecosistema por construcción y —más importante— que quien la recibe
 * sepa A QUÉ NODO preguntarle. Sin el prefijo habría que pregonarla a toda la
 * malla y quedarse con la primera respuesta, que es exactamente cómo se cuela un
 * nodo hostil a quedarse con emparejamientos ajenos.
 */
const crypto = require('crypto');

const ALLOWED_CHARS = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CODE_BODY_LEN = 4;                       // + 2 de prefijo de nodo = 6
const DEFAULT_TTL_MS = 5 * 60 * 1000;          // 5 minutos
const MAX_TTL_MS = 30 * 60 * 1000;
const MAX_CODES = 10000;

/** Normaliza lo que teclea una persona: mayúsculas, sin espacios ni guiones. */
function normalizeCode(raw) {
    if (typeof raw !== 'string') return null;
    const clean = raw.toUpperCase().replace(/[\s-]/g, '');
    return clean.length ? clean : null;
}

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
     * Crea (o renueva) la cita de una conexión.
     * @returns {{code:string, expiresAt:number}|null} null si no hay prefijo de nodo.
     */
    create({ instance, pubkey = null, nodePrefix, ttlMs }) {
        if (!nodePrefix) return null;
        if (this.codes.size >= MAX_CODES) this.cleanup();
        if (this.codes.size >= MAX_CODES) return null;

        // Una cita viva por conexión: pedir otra invalida la anterior, así no
        // quedan códigos sueltos apuntando a la misma persona.
        this.release(instance);

        const ttl = Math.min(Math.max(Number(ttlMs) || this.ttlMs, 30 * 1000), MAX_TTL_MS);
        const expiresAt = Date.now() + ttl;
        let code = null;
        for (let i = 0; i < 50; i++) {
            const candidate = nodePrefix + this._randomBody();
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
