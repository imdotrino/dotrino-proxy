/**
 * El alfabeto de los identificadores del ecosistema, en UN solo sitio.
 *
 * Estaba duplicado en nodeIdentity.js, pairingCodes.js y tokenManager.js. Tres
 * copias de una constante que TIENE que ser idéntica en todas: si se
 * desincronizan, un nodo emite códigos que otro considera inválidos y el fallo
 * aparece lejos del cambio.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTOS SÍMBOLOS
 *
 * La CITA la lee una persona en una pantalla, la teclea, y —el caso que motiva
 * todo esto— la DICTA en voz alta ("pásame tu pin"). El alfabeto viejo excluía el
 * `0` por la `O`, pero dejaba vivos los demás pares:
 *
 *      1/I    5/S    2/Z    8/B    6/G     y en español hablado, B/V
 *
 * La regla que ordena la solución es una sola:
 *
 *      SOLO SE PUEDE MAPEAR A LA ENTRADA UN CARÁCTER QUE NUNCA SE EMITE.
 *
 * Mapear `S→5` mientras se sigue emitiendo `S` sería peor que no hacer nada:
 * quien lee una `S` de verdad en la pantalla y la teclea obtendría un `5` y su
 * código correcto se volvería inválido. Por eso cada par se resuelve sacando UNO
 * de los dos de la emisión, y solo entonces se lo acepta a la entrada.
 *
 * Se saca la LETRA y se conserva el DÍGITO (salvo la O, que ya venía elegida):
 * los dígitos son más rápidos de dictar y no tienen ambigüedad de nombre.
 *
 * Efecto colateral que vale la pena: al salir la `B` desaparece el B/V, que es la
 * confusión hablada más fuerte del español ("be larga" / "ve corta").
 *
 * Lo que NO se saca, a propósito: M/N, U/V, D/T y compañía se confunden al
 * dictar, pero sacarlos cuesta entropía real y el fallo es RECUPERABLE — sale
 * "código no válido" y se pide otro. Distinto de un par visual, que hace fallar
 * a alguien que está leyendo bien.
 *
 * Coste medido de pasar de 35 a 29 símbolos: la cita cae de 1,84e9 a 5,95e8
 * (÷3,1); el id de nodo, de 3,4e18 a 3,5e17 — moler el de otro sigue costando
 * ~170.000 años. Se paga con gusto: un código que se dicta mal no lo salva
 * ninguna entropía.
 */

/** Lo que se EMITE. 29 símbolos: sin 0, sin minúsculas, sin confundibles. */
const ALPHABET = '123456789ACDEFHJKMNOPQRTUVWXY';

/**
 * Lo que se ACEPTA a la entrada y a qué se traduce. Ninguna de estas claves
 * está en ALPHABET — si estuviera, traducirla rompería códigos legítimos.
 */
const CONFUSABLES = {
    I: '1', L: '1',   // palo vertical
    S: '5',
    Z: '2',
    B: '8',
    G: '6',
    0: 'O'            // el 0 no se emite nunca; si alguien lo teclea, quiso decir O
};

/**
 * Normaliza lo que teclea o dicta una persona: mayúsculas, sin espacios ni
 * guiones (se muestran agrupados), y con los confundibles traducidos.
 */
function normalize(raw) {
    if (typeof raw !== 'string') return null;
    let out = '';
    // Se descarta CUALQUIER espacio en blanco, no una lista de tres: un código
    // pegado del portapapeles suele traer un salto de línea al final, y con una
    // lista cerrada eso lo volvía inválido sin que se entendiera por qué.
    for (const ch of raw.toUpperCase()) {
        if (/\s/.test(ch) || ch === '-' || ch === '_') continue;
        out += Object.prototype.hasOwnProperty.call(CONFUSABLES, ch) ? CONFUSABLES[ch] : ch;
    }
    return out.length ? out : null;
}

/** ¿Son todos símbolos emitibles? (usar SIEMPRE sobre el texto ya normalizado) */
function isEmittable(s) {
    return typeof s === 'string' && s.length > 0 && [...s].every((c) => ALPHABET.includes(c));
}

// Palabras que pueden salir del sorteo y que nadie quiere mostrarle a otra
// persona. No es censura ni pretende ser exhaustivo: es que el código son 6
// caracteres visibles y volver a sortear sale gratis. Sacar una letra del
// alfabeto (Crockford saca la U por esto) no alcanza — sin U siguen saliendo
// PENE, TETA, CACA — y cuesta entropía.
//
// Solo se listan las que el alfabeto PUEDE producir: las que llevan L o S ya son
// imposibles por construcción (CULO, ANAL, CULIAO…), así que ponerlas sería
// dar la impresión de que el filtro hace más de lo que hace.
const FEOS = ['PUTA', 'PUTO', 'TETA', 'PENE', 'CACA', 'PEDO', 'MOCO', 'MEAR', 'KKK'];

/** ¿El código sorteado contiene algo que da vergüenza dictar? */
function isUnfortunate(code) {
    const up = String(code || '').toUpperCase();
    return FEOS.some((w) => up.includes(w));
}

module.exports = { ALPHABET, CONFUSABLES, normalize, isEmittable, isUnfortunate, FEOS };
