/**
 * LAS ÚLTIMAS ACTAS DE CADA CUENTA, EN MEMORIA (dueño, 2026-11-04).
 *
 * Para qué: un aparato que quiere saber si su acta va atrás tenía que preguntarle a la
 * bóveda, y la bóveda puede estar dormida (en una Lambda) o lejos: una ventana de Terminal
 * esperaba 4-17 s a pedir la clave de otra máquina. El proxio ya ve el acta de cada aparato
 * que se identifica; con esto se queda con las más nuevas y se las da a quien pregunta.
 *
 * NO ES UNA FUENTE DE VERDAD. El proxio solo comprueba lo que comprueba al identificar (que
 * el acta la selló la llave de la cuenta o una selladora que esa llave respalda); quien la
 * pide la ADOPTA SOLO SI ENCADENA desde la que ya tiene de confianza. Si el proxio mintiera,
 * lo peor que pasa es que se le ignora y se pregunta a la bóveda, como antes.
 *
 * Es una caché: vive en memoria, tiene topes, y perderla (un reinicio) solo cuesta volver a
 * preguntar a la bóveda.
 */

/** Cuántas actas se guardan por cuenta: las de `seq` más alto. */
const PER_PROFILE = 3
/** Un acta más grande que esto no se guarda (el frame del proxio corta a 1 MB). */
const MAX_ACTA_BYTES = 256 * 1024
/** Cuántas cuentas como mucho; se va la que lleva más tiempo sin tocarse. */
const MAX_PROFILES = 20000

class ActaCache {
    constructor({ perProfile = PER_PROFILE, maxBytes = MAX_ACTA_BYTES, maxProfiles = MAX_PROFILES } = {}) {
        this.perProfile = perProfile
        this.maxBytes = maxBytes
        this.maxProfiles = maxProfiles
        /** profileId → [{ seq, sig, acta, bytes }] ordenadas de más nueva a más vieja. Un Map
         *  recuerda el orden de inserción: se reinserta al tocar, y la primera es la más vieja. */
        this.byProfile = new Map()
    }

    /**
     * Guarda `acta` (ya comprobada por quien llama) para `profileId`. Devuelve `true` si entró:
     * no entra si es más vieja que todas las guardadas con la lista llena, si ya estaba, o si
     * pesa demasiado.
     */
    put(profileId, acta) {
        if (typeof profileId !== 'string' || !acta || !Number.isInteger(acta.seq) || typeof acta.sig !== 'string') return false
        let bytes
        try { bytes = Buffer.byteLength(JSON.stringify(acta)) } catch { return false }
        if (bytes > this.maxBytes) return false
        const list = this.byProfile.get(profileId) || []
        // La misma acta (misma firma) no se guarda dos veces. Dos DISTINTAS con el mismo `seq`
        // sí: con dos bóvedas en la cuenta puede pasar, y decidir cuál vale es de quien adopta.
        if (list.some((e) => e.sig === acta.sig)) { this._touch(profileId, list); return false }
        if (list.length >= this.perProfile && acta.seq <= list[list.length - 1].seq) return false
        list.push({ seq: acta.seq, sig: acta.sig, acta, bytes })
        list.sort((a, b) => b.seq - a.seq)
        list.length = Math.min(list.length, this.perProfile)
        this._touch(profileId, list)
        while (this.byProfile.size > this.maxProfiles) this.byProfile.delete(this.byProfile.keys().next().value)
        return true
    }

    /** Las guardadas de `profileId` con `seq` MAYOR que `sinceSeq`, de más nueva a más vieja. */
    get(profileId, sinceSeq = -1) {
        const list = this.byProfile.get(profileId)
        if (!list) return []
        this._touch(profileId, list)
        return list.filter((e) => e.seq > sinceSeq).map((e) => e.acta)
    }

    _touch(profileId, list) {
        this.byProfile.delete(profileId)
        this.byProfile.set(profileId, list)
    }

    get size() { return this.byProfile.size }
}

module.exports = { ActaCache, PER_PROFILE, MAX_ACTA_BYTES, MAX_PROFILES }
