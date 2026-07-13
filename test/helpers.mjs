import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
// SQLite en memoria por proceso: los archivos de test corren en paralelo y
// compartir ./proxy-data.db (o pisarlo con el dev server vivo) da
// "database is locked". Debe setearse ANTES de requerir server.js
// (persist.init corre al cargar el módulo).
process.env.PROXY_DB_FILE = ':memory:';
const { start, stop } = require('../server');

export async function startTestServer() {
    process.env.NODE_ENV = 'test';
    const port = await start(0);
    return {
        port,
        url: `ws://127.0.0.1:${port}`
    };
}

export async function stopTestServer() {
    await stop();
}

/**
 * Conecta un cliente WebSocket y espera a recibir el evento `connected`.
 * Devuelve un wrapper con utilidades:
 *   - ws: el WebSocket subyacente
 *   - token: el token asignado por el servidor
 *   - recv: array de todos los mensajes JSON recibidos (en orden)
 *   - send(obj): envía un mensaje JSON
 *   - waitFor(predicate, opts?): espera un mensaje que cumpla el predicado
 *   - close(): cierra el socket y resuelve cuando termina el handshake
 */
export function connectClient(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const recv = [];
        const waiters = [];
        let token = null;
        let resolved = false;

        const timeout = setTimeout(() => {
            if (resolved) return;
            try { ws.close(); } catch (_) { /* noop */ }
            reject(new Error(`Timeout esperando 'connected' de ${url}`));
        }, 3000);

        ws.on('message', (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch (e) {
                return;
            }

            // Capturar el primer 'connected' para el handshake
            if (!resolved && msg.type === 'connected' && msg.token) {
                token = msg.token;
                resolved = true;
                clearTimeout(timeout);
                resolve(buildClient(ws, () => token, recv, waiters));
                return; // no agregar el mensaje 'connected' a recv (se considera handshake)
            }

            recv.push(msg);
            // Resolver waiters pendientes
            for (let i = waiters.length - 1; i >= 0; i--) {
                if (waiters[i].predicate(msg)) {
                    clearTimeout(waiters[i].timer);
                    waiters[i].resolve(msg);
                    waiters.splice(i, 1);
                }
            }
        });

        ws.on('error', (err) => {
            clearTimeout(timeout);
            if (!resolved) reject(err);
        });
    });
}

function buildClient(ws, getToken, recv, waiters) {
    const client = {
        ws,
        get token() { return getToken(); },
        recv,

        send(obj) {
            ws.send(JSON.stringify(obj));
        },

        /**
         * Resuelve con el primer mensaje (entrante o ya recibido) que cumpla `predicate`.
         * Si `opts.fromNow` es true, solo considera mensajes futuros.
         */
        waitFor(predicate, opts = {}) {
            const timeout = opts.timeout ?? 2000;

            if (!opts.fromNow) {
                const existing = recv.find(predicate);
                if (existing) return Promise.resolve(existing);
            }

            return new Promise((resolve, reject) => {
                const startIndex = recv.length;
                const wrappedPredicate = opts.fromNow
                    ? (msg) => recv.indexOf(msg) >= startIndex && predicate(msg)
                    : predicate;

                const timer = setTimeout(() => {
                    const idx = waiters.indexOf(entry);
                    if (idx >= 0) waiters.splice(idx, 1);
                    reject(new Error(`Timeout esperando mensaje. Recibidos: ${JSON.stringify(recv)}`));
                }, timeout);

                const entry = { predicate: wrappedPredicate, resolve, timer };
                waiters.push(entry);
            });
        },

        /**
         * Espera un período corto y devuelve true si NO se recibió ningún mensaje
         * que cumpla `predicate`. Útil para asertar ausencia de eventos.
         */
        async expectNoMessage(predicate, timeout = 200) {
            try {
                await client.waitFor(predicate, { timeout, fromNow: true });
                return false;
            } catch (e) {
                return true;
            }
        },

        close() {
            return new Promise((resolve) => {
                if (ws.readyState === WebSocket.CLOSED) return resolve();
                ws.once('close', () => resolve());
                ws.close();
            });
        }
    };
    return client;
}

/**
 * Construye un objeto de canal con el formato firmado esperado por el servidor.
 * Usa una firma con prefijo MOCK- que el servidor acepta vía validateSignatureBasic
 * (path de fallback para desarrollo). Para tests no necesitamos criptografía real.
 */
// Firma REAL (ECDSA P-256 ieee-p1363 sobre JSON canónico): desde el fix de
// verificación estricta el servidor rechaza firmas de mentira, así que los
// tests firman con una llave efímera generada por proceso.
const { generateKeyPairSync, sign: signSync } = require('crypto');
const _chanKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const _chanPubJwk = _chanKeys.publicKey.export({ format: 'jwk' });
export const TEST_CHANNEL_PUBKEY = JSON.stringify({
    kty: 'EC', crv: 'P-256', x: _chanPubJwk.x, y: _chanPubJwk.y
});

function canonicalStringify(obj) {
    if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

export function signEnvelope(data) {
    return signSync(
        'sha256',
        Buffer.from(canonicalStringify(data), 'utf8'),
        { key: _chanKeys.privateKey, dsaEncoding: 'ieee-p1363' }
    ).toString('base64');
}

export function makeMockChannel(name, extraData = {}) {
    const data = { name, publickey: TEST_CHANNEL_PUBKEY, ...extraData };
    return { data, signature: signEnvelope(data) };
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
