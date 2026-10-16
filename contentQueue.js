'use strict';

/**
 * Los mensajes EN TRÁNSITO (la cola offline de 24 h) viven en el `dotrino-content` de la
 * cuenta del propio proxio, no en su SQLite. Decidido por el dueño el 2026-10-15, para que
 * el messenger pueda mandar imágenes: la cola en SQLite tenía 1 MB por destinatario, que son
 * tres fotos, y todo el cuerpo vivía además en la RAM del proceso.
 *
 * Qué queda en cada sitio:
 *   - en el content, el CUERPO: el sobre tal como lo mandó quien escribe (ya sellado, así
 *     que el node solo ve bytes cifrados), subido con `enc=1` y con su `ttl`;
 *   - en SQLite y en RAM, el ÍNDICE: para quién es, de quién, de qué app, cuándo vence y el
 *     `cid` donde está el cuerpo.
 *
 * Se habla con el node por su HTTP LOCAL (`PROXY_CONTENT_URL`, p. ej.
 * `http://127.0.0.1:3777`), que no tiene el tope de 256 KB del plano de control: el node
 * corre en la misma máquina. Ese HTTP no autentica, así que antes de guardar nada se
 * comprueba que el node es DE LA MISMA CUENTA que el proxio (`owner` de `/stats` contra la
 * huella de la `iss` con la que se enroló el proxio). Si no lo es, o no contesta, la cola no
 * acepta mensajes y lo dice: no se cae a guardar en SQLite, que es justo lo que esto cambia.
 *
 * Cada cuerpo se envuelve con el destinatario y un nonce antes de subir. El content
 * direcciona por hash, y dos mensajes idénticos a dos destinatarios darían el MISMO `cid`:
 * entregar uno borraría el del otro.
 */

const crypto = require('crypto');
const { encodeFrame, decodeFrame, FRAME_VERSION } = require('./body');

const TIMEOUT_MS = 10000;
const RECHECK_MS = 60 * 1000;

function err(message, code) {
    return Object.assign(new Error(message), { code });
}

async function request(url, opts = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
    catch (e) { throw err(`content node unreachable at ${url}: ${e.message}`, 'content-unreachable'); }
    finally { clearTimeout(t); }
}

/**
 * @param {{ url: string, owner: () => Promise<string|null>, log?: (...a:any[]) => void }} o
 *   `owner`: la huella de la cuenta del proxio (o null si no está enrolado).
 */
function createContentQueue({ url, owner, log = console.log }) {
    const base = String(url).replace(/\/+$/, '');
    // ready: null = sin comprobar todavía; true = es el node de nuestra cuenta; false = no.
    const state = { ready: null, reason: null, owner: null };
    let checking = null;
    let timer = null;

    async function check() {
        try {
            const mine = await owner();
            if (!mine) throw err('this proxy is not enrolled to a vault: it has no account to own a content node', 'no-account');
            const r = await request(`${base}/stats`);
            if (!r.ok) throw err(`content node answered ${r.status} to /stats`, 'content-unreachable');
            const stats = await r.json();
            if (!stats.owner) throw err('the content node does not say whose it is (needs @dotrino/content >= 0.5.3, linked to a vault)', 'content-no-owner');
            if (stats.owner !== mine) throw err(`the content node belongs to another account (${String(stats.owner).slice(0, 12)}…, this proxy is ${mine.slice(0, 12)}…)`, 'content-other-account');
            if (state.ready !== true) log(`[queue] in-flight messages are stored in the content node ${base} (account ${mine.slice(0, 12)}…)`);
            state.ready = true; state.reason = null; state.owner = mine;
        } catch (e) {
            if (state.reason !== e.code) console.error(`[queue] the content node cannot hold the offline queue: ${e.message}`);
            state.ready = false; state.reason = e.code || 'content-unreachable';
        }
        return state.ready;
    }

    /** Comprueba (una a la vez) y vuelve a mirar cada minuto mientras no esté listo. */
    function ensure() {
        if (state.ready === true) return Promise.resolve(true);
        if (!checking) checking = check().finally(() => { checking = null; });
        return checking;
    }

    function start() {
        ensure();
        if (!timer) {
            timer = setInterval(() => { if (state.ready !== true) ensure(); }, RECHECK_MS);
            if (timer.unref) timer.unref();
        }
    }

    function stop() { if (timer) clearInterval(timer); timer = null; }

    /** Guarda el cuerpo y devuelve su `cid`. Lanza con `code` si no se pudo. */
    async function put(recipient, message, expiresAt) {
        if (!(await ensure())) throw err(`offline queue unavailable: ${state.reason}`, 'queue-unavailable');
        // Un cuerpo en bytes (body.js) se guarda en crudo detrás de la envoltura, sin base64:
        // [0x01][u32 largo][JSON { to, n }][bytes]. El texto, como siempre, en un JSON.
        const wrap = { to: recipient, n: crypto.randomBytes(12).toString('base64url') };
        const body = Buffer.isBuffer(message) ? encodeFrame(wrap, message) : JSON.stringify({ ...wrap, message });
        const ttl = Math.max(60 * 1000, expiresAt - Date.now());
        const r = await request(`${base}/c?enc=1&ttl=${ttl}`, {
            method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body
        });
        if (!r.ok) {
            // Un 5xx o un 507 (cuota) dicen que el node está mal: se vuelve a comprobar.
            if (r.status >= 500) { state.ready = null; }
            throw err(`content node rejected the message (${r.status})`, r.status === 507 ? 'queue-full' : 'queue-unavailable');
        }
        const out = await r.json();
        if (!out || typeof out.cid !== 'string') throw err('content node did not return a cid', 'queue-unavailable');
        return out.cid;
    }

    /** El mensaje guardado en `cid`. Lanza con `code` si no está o no cuadra. */
    async function get(cid, recipient) {
        const r = await request(`${base}/c/${encodeURIComponent(cid)}`);
        if (r.status === 404) throw err(`queued message ${cid} is gone from the content node`, 'queue-gone');
        if (!r.ok) throw err(`content node answered ${r.status} for ${cid}`, 'content-unreachable');
        const bytes = Buffer.from(await r.arrayBuffer());
        // El cid ES el hash: lo que no cuadre no se entrega, venga de donde venga.
        const hash = 'sha256-' + crypto.createHash('sha256').update(bytes).digest('hex');
        if (hash !== cid) throw err(`queued message ${cid} does not match its hash`, 'queue-corrupt');
        let body;
        if (bytes[0] === FRAME_VERSION) {
            const f = decodeFrame(bytes);
            body = { to: f.header.to, message: Buffer.from(f.body) };
        } else {
            body = JSON.parse(bytes.toString('utf8'));
        }
        if (body.to !== recipient) throw err(`queued message ${cid} is for someone else`, 'queue-corrupt');
        return body.message;
    }

    /** Borra un cuerpo ya entregado o descartado. Lo que falle lo recoge el GC del node al vencer. */
    async function remove(cid) {
        try {
            const r = await request(`${base}/c/${encodeURIComponent(cid)}`, { method: 'DELETE' });
            if (!r.ok && r.status !== 404) console.warn(`[queue] could not delete ${cid} from the content node (${r.status}); its ttl will collect it`);
        } catch (e) {
            console.warn(`[queue] could not delete ${cid} from the content node (${e.message}); its ttl will collect it`);
        }
    }

    return { start, stop, ensure, put, get, remove, state, url: base };
}

module.exports = { createContentQueue };
