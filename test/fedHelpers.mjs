/**
 * Arnés de DOS NODOS reales para probar la federación.
 *
 * `server.js` guarda su estado en módulo (activeConnections, peerRegistry, la
 * identidad del nodo…) y lo lee del entorno al cargar, así que dos nodos no
 * pueden convivir en un mismo proceso. Cada nodo se levanta con
 * `child_process.fork` y su propio entorno: identidad de vault falsa, base
 * SQLite propia y `PROXY_PEERS` cruzado.
 *
 * Sin esto no había forma de probar la federación: hasta la fase 1 el repo tenía
 * CERO tests que la cubrieran, y por eso pasó inadvertido que en producción
 * nunca estuvo encendida.
 */
import { createRequire } from 'module';
import { fork } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const crypto = require('crypto');
const WebSocket = require('ws');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.js');

/** Identidad de servicio con la misma forma que la que escribe el vault. */
export function writeFakeVaultIdentity(dir) {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicJwk = kp.publicKey.export({ format: 'jwk' });
    const privateJwk = kp.privateKey.export({ format: 'jwk' });
    const publickey = JSON.stringify(publicJwk);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'service-identity.json'), JSON.stringify({
        v: 1, ns: 'proxy', iss: 'test-master', enrolledAt: Date.now(),
        device: { publickey, privateJwk, publicJwk, label: 'test', createdAt: Date.now() }
    }));
    return { publickey, privateJwk };
}

/** Reserva un puerto libre pidiéndoselo al SO y soltándolo. */
export function freePort() {
    return new Promise((resolve, reject) => {
        const net = require('net');
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const p = srv.address().port;
            srv.close(() => resolve(p));
        });
    });
}

/**
 * Levanta un nodo en un proceso aparte. Resuelve cuando /health responde.
 *
 * El puerto se fija de antemano (en vez de leerlo del log) porque con
 * NODE_ENV=test el servidor arranca en silencio a propósito.
 */
export async function startNode({ name, dir, peers = [], port, env = {} } = {}) {
    const actualPort = port || await freePort();
    const log = [];
    const child = fork(SERVER, [], {
        env: {
            ...process.env,
            NODE_ENV: 'test',
            PORT: String(actualPort),
            HOST: '127.0.0.1',
            PROXY_DB_FILE: path.join(dir, 'proxy.db'),
            VAULT_SERVICE_DIR: path.join(dir, 'vault-service'),
            PROXY_PEERS: peers.join(','),
            PROXY_PUBLIC_URL: `http://127.0.0.1:${actualPort}`,
            RATE_LIMIT_DISABLED: '1',
            ...env
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });

    const attach = (stream) => {
        let buf = '';
        stream.on('data', (c) => {
            buf += c.toString();
            let i;
            while ((i = buf.indexOf('\n')) >= 0) { log.push(`[${name}] ${buf.slice(0, i)}`); buf = buf.slice(i + 1); }
        });
    };
    attach(child.stdout);
    attach(child.stderr);

    let died = null;
    child.on('exit', (code) => { died = code; });

    const node = {
        name, port: actualPort, log, child,
        url: `ws://127.0.0.1:${actualPort}`,
        http: `http://127.0.0.1:${actualPort}`,
        stop: () => new Promise((res) => {
            if (child.exitCode !== null || child.signalCode) return res();
            child.once('exit', () => res());
            child.kill('SIGKILL');
        })
    };

    const deadline = Date.now() + 15000;
    for (;;) {
        if (died !== null) throw new Error(`[${name}] murió (code ${died}):\n${log.join('\n')}`);
        try {
            const r = await fetch(`${node.http}/health`);
            if (r.ok) break;
        } catch (_) { /* todavía no escucha */ }
        if (Date.now() > deadline) {
            await node.stop();
            throw new Error(`[${name}] no arrancó a tiempo:\n${log.join('\n')}`);
        }
        await sleep(120);
    }

    // El id de nodo ya NO se puede fijar por entorno: se DERIVA de la llave del
    // nodo, que es lo que hace que nadie pueda usar el ajeno. Así que el arnés lo
    // lee de `/peers` en vez de imponerlo, y los tests comparan contra él.
    try {
        const info = await fetch(`${node.http}/peers`).then((r) => r.json());
        node.nodeId = info?.self?.nodeId || null;
        node.hint = info?.self?.hint || null;
    } catch (_) { node.nodeId = null; node.hint = null; }

    return node;
}

/** Crea un directorio temporal con identidad de vault dentro. */
export function makeNodeDir(label) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dotrino-fed-${label}-`));
    writeFakeVaultIdentity(path.join(dir, 'vault-service'));
    return dir;
}

/** Cliente WebSocket mínimo contra un nodo. */
export function connectTo(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const recv = [];
        const listeners = [];
        const t = setTimeout(() => reject(new Error(`timeout conectando a ${url}`)), 8000);
        ws.on('message', (raw) => {
            let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
            recv.push(m);
            for (const l of listeners.slice()) if (l.pred(m)) { l.done(m); }
            if (m.type === 'connected') {
                clearTimeout(t);
                resolve({
                    ws, recv, token: m.token,
                    send: (o) => ws.send(JSON.stringify(o)),
                    waitFor: (pred, ms = 6000) => new Promise((res, rej) => {
                        const hit = recv.find(pred);
                        if (hit) return res(hit);
                        const timer = setTimeout(() => rej(new Error(`timeout esperando; recibido: ${JSON.stringify(recv)}`)), ms);
                        listeners.push({ pred, done: (msg) => { clearTimeout(timer); res(msg); } });
                    }),
                    // `close()` hace el handshake de cierre y espera la respuesta
                    // del servidor. Si el servidor ya está muerto (los tests lo
                    // matan a propósito) esa respuesta no llega nunca y `ws` se
                    // queda esperando su timeout de 30 s: por eso, si no cierra
                    // rápido, se termina a la fuerza.
                    close: () => new Promise((res) => {
                        if (ws.readyState === WebSocket.CLOSED) return res();
                        const t = setTimeout(() => { try { ws.terminate(); } catch (_) {} res(); }, 800);
                        ws.once('close', () => { clearTimeout(t); res(); });
                        try { ws.close(); } catch (_) { clearTimeout(t); res(); }
                    })
                });
            }
        });
        ws.on('error', (e) => { clearTimeout(t); reject(e); });
    });
}

function canonical(obj) {
    if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
    return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

/** Identidad de USUARIO (para identify), con su firma. */
export function makeUser() {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = kp.publicKey.export({ format: 'jwk' });
    const publickey = JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });
    return {
        publickey,
        sign: (data) => crypto.sign('sha256', Buffer.from(canonical(data), 'utf8'),
            { key: kp.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64')
    };
}

/** Conecta e identifica a un usuario contra un nodo. */
export async function connectIdentified(url, user) {
    const c = await connectTo(url);
    const data = { op: 'identify', publickey: user.publickey, token: c.token, ts: Date.now() };
    c.send({ type: 'identify', data, signature: user.sign(data) });
    const res = await c.waitFor((m) => m.type === 'identified' || m.type === 'error');
    if (res.type === 'error') throw new Error('identify falló: ' + res.error);
    return c;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
