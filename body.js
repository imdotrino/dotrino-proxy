'use strict';

/**
 * EL CUERPO DE UN MENSAJE: texto o bytes (1.6.0).
 *
 * Desde `@dotrino/proxy-client` 0.35.0 un mensaje con archivos viaja en una TRAMA BINARIA:
 *
 *     [0x01][u32 largo de la cabecera][cabecera JSON][cuerpo]
 *
 * La cabecera es la trama de texto de siempre sin `message` (`to`, `to_publickey`, `id`,
 * `app`…), y el cuerpo es el `message` en crudo, ya sellado. El proxio lee la cabecera para
 * enrutar y no mira el cuerpo. El formato lo define el cliente (`src/binpack.js`); esto es la
 * otra punta del mismo cable.
 *
 * Dentro del proxio el cuerpo es una cadena (texto, como siempre) o un `Buffer` (bytes). Se
 * entrega como llegó: texto en texto y bytes en una trama binaria. La malla entre nodos también
 * los lleva en crudo (mesh.js): en base64 una parte de 768 KB no cabe en la trama de 1 MB. Por
 * donde solo cabe JSON —el POST de federación, la fila de SQLite— viajan en base64 dentro de
 * `{ __dotrino_bin_b64 }`, y se vuelven `Buffer` al otro lado.
 */

const FRAME_VERSION = 0x01;
const B64_TAG = '__dotrino_bin_b64';

function withCode(message, code) {
    return Object.assign(new Error(message), { code });
}

/** La trama binaria: cabecera JSON + cuerpo. */
function encodeFrame(header, body) {
    const head = Buffer.from(JSON.stringify(header), 'utf8');
    const out = Buffer.allocUnsafe(5 + head.length + body.length);
    out[0] = FRAME_VERSION;
    out.writeUInt32BE(head.length, 1);
    head.copy(out, 5);
    body.copy(out, 5 + head.length);
    return out;
}

/** `{ header, body }`, o lanza con `code: 'bad-frame'`. */
function decodeFrame(data) {
    const b = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    if (b.length < 5 || b[0] !== FRAME_VERSION) throw withCode('not a binary frame of a known version', 'bad-frame');
    const len = b.readUInt32BE(1);
    if (5 + len > b.length) throw withCode('binary frame is shorter than its header says', 'bad-frame');
    let header;
    try { header = JSON.parse(b.subarray(5, 5 + len).toString('utf8')); }
    catch (_) { throw withCode('binary frame header is not JSON', 'bad-frame'); }
    if (!header || typeof header !== 'object' || Array.isArray(header)) throw withCode('binary frame header is not an object', 'bad-frame');
    return { header, body: b.subarray(5 + len) };
}

/** Entrega un mensaje a una conexión como llegó: bytes en trama binaria, texto en JSON. */
function sendMessage(ws, header, body) {
    if (Buffer.isBuffer(body)) ws.send(encodeFrame(header, body), { binary: true });
    else ws.send(JSON.stringify({ ...header, message: body }));
}

/** Para un salto que solo admite JSON: los bytes, en base64 marcado. */
function toJson(body) {
    return Buffer.isBuffer(body) ? { [B64_TAG]: body.toString('base64') } : body;
}

/** El inverso de `toJson`. */
function fromJson(v) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v[B64_TAG] === 'string' && Object.keys(v).length === 1) {
        return Buffer.from(v[B64_TAG], 'base64');
    }
    return v;
}

/** Lo que ocupa un cuerpo, para los topes de la cola. */
function bodyBytes(body) {
    if (Buffer.isBuffer(body)) return body.length;
    try { return Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'); }
    catch (_) { return 0; }
}

module.exports = { encodeFrame, decodeFrame, sendMessage, toJson, fromJson, bodyBytes, FRAME_VERSION };
