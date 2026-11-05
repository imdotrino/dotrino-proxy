'use strict';

const { toJson, fromJson } = require('./body');

// Persistencia durable del proxy usando el SQLite nativo de Node (node:sqlite,
// Node >= 22.5). Solo persistimos lo que NO es efímero:
//   - push_subscriptions: pubkey -> PushSubscription (perderlas = no timbrar)
//   - offline_queue: mensajes encolados 24h para destinatarios offline (con
//     PROXY_CONTENT_URL, solo el índice: el cuerpo vive en el dotrino-content)
//
// Los mapas token<->pubkey y los canales públicos NO se persisten: son
// efímeros por diseño (el token cambia en cada conexión, los canales expiran).
//
// Modelo write-through: server.js mantiene los Maps en RAM como working set y
// llama a estas funciones para reflejar cada cambio en disco. Al arrancar,
// `loadOfflineQueue()` y `loadPushSubscriptions()` rehidratan los Maps.

const { DatabaseSync } = require('node:sqlite');

/** @type {import('node:sqlite').DatabaseSync | null} */
let db = null;

/**
 * La base abierta por `init`. Usarla antes es un fallo del llamador: se dice con un error
 * que se pueda buscar, en vez del «cannot read properties of null» de antes.
 * @returns {import('node:sqlite').DatabaseSync}
 */
function getDb() {
    if (!db) throw new Error('persistence: not initialized (call init first)');
    return db;
}

/**
 * @param {string} dbFile
 * @returns {import('node:sqlite').DatabaseSync}
 */
function init(dbFile) {
    db = new DatabaseSync(dbFile);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec(`
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            pubkey       TEXT NOT NULL,
            app          TEXT NOT NULL DEFAULT '',
            subscription TEXT NOT NULL,
            updated_at   INTEGER NOT NULL,
            PRIMARY KEY (pubkey, app)
        );
        CREATE TABLE IF NOT EXISTS offline_queue (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            pubkey      TEXT NOT NULL,
            from_token  TEXT,
            from_pubkey TEXT,
            message     TEXT NOT NULL,
            queued_at   INTEGER NOT NULL,
            expires_at  INTEGER NOT NULL,
            bytes       INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_offline_pubkey ON offline_queue(pubkey);
        CREATE TABLE IF NOT EXISTS scheduled_pushes (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            pubkey     TEXT NOT NULL,
            payload    TEXT,
            next_fire  INTEGER NOT NULL,
            cron       TEXT,
            tz         TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sched_nextfire ON scheduled_pushes(next_fire);
        CREATE INDEX IF NOT EXISTS idx_sched_pubkey ON scheduled_pushes(pubkey);
        CREATE TABLE IF NOT EXISTS home_registrations (
            pubkey     TEXT PRIMARY KEY,
            updated_at INTEGER NOT NULL
        );
        -- Directorio de llaves de CIFRADO: el anuncio firmado con el que una identidad
        -- dice «se me sella a esta llave». Se guarda el sobre ENTERO (data + signature)
        -- porque el que pregunta verifica la firma él mismo: si guardáramos solo la
        -- llave, este servidor pasaría de buzón a autoridad y podría cambiarla por la
        -- suya sin que nadie lo notara. Persistente a propósito: el destinatario de un
        -- mensaje encolado 24 h está, por definición, desconectado.
        CREATE TABLE IF NOT EXISTS enc_pubkeys (
            pubkey     TEXT PRIMARY KEY,
            data       TEXT NOT NULL,
            signature  TEXT NOT NULL,
            ts         INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
    `);

    // `peer_nodes` va APARTE del bloque de arriba, y el índice DESPUÉS de la
    // migración. Estaban juntos y eso tiraba el proceso al arrancar contra una
    // base existente: `CREATE TABLE IF NOT EXISTS` no hace nada si la tabla ya
    // está (con el esquema viejo, que tenía `prefix`), y la línea siguiente
    // creaba un índice sobre `node_id` → "no such column: node_id", antes de que
    // el código de migración llegara a correr.
    //
    // El esquema viejo guardaba un id de nodo DECLARADO en vez de derivado de la
    // llave. No se migra el contenido: arrastrarlo sería seguir confiando justo
    // en lo que dejó de valer, y los pineos se rehacen solos en el siguiente
    // descubrimiento (segundos).
    // EL TIMBRE ES POR APP (dueño, 2026-09-30: «el timbre, si bien no sabe el contenido, sí
    // debería ser dirigido»). En un teléfono varias apps comparten la llave del perfil, y con
    // una suscripción por llave la última que se registraba se llevaba todos los timbres:
    // messenger sonaba con los pedidos de la bóveda y con cualquier ping. Ahora la clave es
    // (llave, app). Las filas viejas pasan con app '' = «sin decir cuál», que timbra todo.
    const subCols = db.prepare('PRAGMA table_info(push_subscriptions)').all().map((c) => c.name);
    if (subCols.length && !subCols.includes('app')) {
        db.exec(`
            CREATE TABLE push_subscriptions_v2 (
                pubkey       TEXT NOT NULL,
                app          TEXT NOT NULL DEFAULT '',
                subscription TEXT NOT NULL,
                updated_at   INTEGER NOT NULL,
                PRIMARY KEY (pubkey, app)
            );
            INSERT INTO push_subscriptions_v2 (pubkey, app, subscription, updated_at)
                SELECT pubkey, '', subscription, updated_at FROM push_subscriptions;
            DROP TABLE push_subscriptions;
            ALTER TABLE push_subscriptions_v2 RENAME TO push_subscriptions;
        `);
    }
    // Y el recordatorio programado también dice su app: suena en la que lo pidió, no en todas.
    const schedCols = db.prepare('PRAGMA table_info(scheduled_pushes)').all().map((c) => c.name);
    if (schedCols.length && !schedCols.includes('app')) db.exec('ALTER TABLE scheduled_pushes ADD COLUMN app TEXT;');
    // Y la cola dice para qué app es cada mensaje: cada app baja lo suyo y no lo de las demás.
    const queueCols = db.prepare('PRAGMA table_info(offline_queue)').all().map((c) => c.name);
    if (!queueCols.includes('app')) db.exec('ALTER TABLE offline_queue ADD COLUMN app TEXT;');
    // Con el cuerpo en el dotrino-content de la cuenta (contentQueue.js), la fila solo
    // guarda DÓNDE está: `cid`, y `message` queda en 'null'.
    if (!queueCols.includes('cid')) db.exec('ALTER TABLE offline_queue ADD COLUMN cid TEXT;');

    const peerCols = db.prepare('PRAGMA table_info(peer_nodes)').all().map((c) => c.name);
    if (peerCols.length && !peerCols.includes('node_id')) db.exec('DROP TABLE peer_nodes;');
    db.exec(`
        CREATE TABLE IF NOT EXISTS peer_nodes (
            url        TEXT PRIMARY KEY,
            pubkey     TEXT NOT NULL,
            node_id    TEXT NOT NULL,
            pinned_at  INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_peer_node_id ON peer_nodes(node_id);
    `);
    return db;
}

// ----- home registrations (federación: "soy el home de esta pubkey") -----
// Se upsertea en cada identify; con TTL para olvidar identidades que ya no usan
// este proxy. Permite que, al recibir un mensaje federado, sólo el HOME encole.

/** @param {string} pubkey @param {number} now */
function upsertHome(pubkey, now) {
    getDb().prepare(`
        INSERT INTO home_registrations (pubkey, updated_at) VALUES (?, ?)
        ON CONFLICT(pubkey) DO UPDATE SET updated_at = excluded.updated_at
    `).run(pubkey, now);
}

/**
 * @param {number} minUpdatedAt
 * @returns {string[]}
 */
function loadHomes(minUpdatedAt) {
    return getDb().prepare('SELECT pubkey FROM home_registrations WHERE updated_at >= ?')
        .all(minUpdatedAt).map(r => String(r.pubkey));
}

/** @param {number} cutoff */
function deleteExpiredHomes(cutoff) {
    getDb().prepare('DELETE FROM home_registrations WHERE updated_at < ?').run(cutoff);
}

// ----- directorio de llaves de cifrado -----------------------------------

/**
 * Guarda el anuncio, pero SOLO si es más nuevo que el que había. El `ts` lo pone quien
 * firma y va dentro de lo firmado, así que un tercero no puede retroceder la llave de
 * nadie reenviando un anuncio viejo por la malla.
 */
/**
 * @param {string} pubkey
 * @param {string} data       JSON del anuncio
 * @param {string} signature
 * @param {number} ts
 * @param {number} now
 */
function upsertEncPub(pubkey, data, signature, ts, now) {
    getDb().prepare(`
        INSERT INTO enc_pubkeys (pubkey, data, signature, ts, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(pubkey) DO UPDATE SET
            data = excluded.data, signature = excluded.signature,
            ts = excluded.ts, updated_at = excluded.updated_at
        WHERE excluded.ts > enc_pubkeys.ts
    `).run(pubkey, data, signature, ts, now);
}

/**
 * @param {number} minUpdatedAt
 * @returns {import('./types/index.js').EncPubRow[]}
 */
function loadEncPubs(minUpdatedAt) {
    return /** @type {import('./types/index.js').EncPubRow[]} */ (/** @type {unknown} */ (getDb().prepare('SELECT pubkey, data, signature, ts FROM enc_pubkeys WHERE updated_at >= ?')
        .all(minUpdatedAt)));
}

/** @param {number} cutoff */
function deleteExpiredEncPubs(cutoff) {
    getDb().prepare('DELETE FROM enc_pubkeys WHERE updated_at < ?').run(cutoff);
}

// ----- meta (clave-valor para config persistida, p.ej. VAPID) ------------

/**
 * @param {string} key
 * @returns {string | null}
 */
function getMeta(key) {
    const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? /** @type {string} */ (row.value) : null;
}

/** @param {string} key @param {string} value */
function setMeta(key, value) {
    getDb().prepare(`
        INSERT INTO meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
}

// ----- push subscriptions ------------------------------------------------

// Map<pubkey, Map<app, subscription>>; app '' = una suscripción que no dijo de qué app es.
/** @returns {Map<string, Map<string, import('./types/index.js').StoredSubscription>>} pubkey → app → suscripción */
function loadPushSubscriptions() {
    const rows = /** @type {Array<{ pubkey: string, app: string | null, subscription: string }>} */ (/** @type {unknown} */ (getDb().prepare('SELECT pubkey, app, subscription FROM push_subscriptions').all()));
    /** @type {Map<string, Map<string, import('./types/index.js').StoredSubscription>>} */
    const out = new Map();
    for (const r of rows) {
        try {
            if (!out.has(r.pubkey)) out.set(r.pubkey, new Map());
            /** @type {Map<string, import('./types/index.js').StoredSubscription>} */ (out.get(r.pubkey)).set(r.app || '', JSON.parse(r.subscription));
        } catch (_) {}
    }
    return out;
}

/**
 * @param {string} pubkey
 * @param {string | null | undefined} app
 * @param {import('./types/index.js').StoredSubscription} subscription
 */
function upsertPushSubscription(pubkey, app, subscription) {
    getDb().prepare(`
        INSERT INTO push_subscriptions (pubkey, app, subscription, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(pubkey, app) DO UPDATE SET subscription = excluded.subscription, updated_at = excluded.updated_at
    `).run(pubkey, app || '', JSON.stringify(subscription), Date.now());
}

// Sin `app` (undefined) borra todas las de esa llave; con app, solo esa.
/**
 * @param {string} pubkey
 * @param {string | null} [app]  sin app: todas las de la pubkey
 */
function deletePushSubscription(pubkey, app) {
    if (app === undefined) getDb().prepare('DELETE FROM push_subscriptions WHERE pubkey = ?').run(pubkey);
    else getDb().prepare('DELETE FROM push_subscriptions WHERE pubkey = ? AND app = ?').run(pubkey, app || '');
}

// ----- offline queue -----------------------------------------------------

// Devuelve Map<pubkey, Array<item>> donde item incluye su `id` de fila.
/**
 * @param {number} now
 * @returns {Map<string, import('./types/index.js').QueuedItem[]>}
 */
function loadOfflineQueue(now) {
    getDb().prepare('DELETE FROM offline_queue WHERE expires_at < ?').run(now);
    const rows = /** @type {Array<{ id: number, pubkey: string, from_token: string | null, from_pubkey: string | null, message: string, queued_at: number, expires_at: number, bytes: number, app: string | null, cid: string | null }>} */ (/** @type {unknown} */ (getDb().prepare(`
        SELECT id, pubkey, from_token, from_pubkey, message, queued_at, expires_at, bytes, app, cid
        FROM offline_queue ORDER BY id ASC
    `).all()));
    /** @type {Map<string, import('./types/index.js').QueuedItem[]>} */
    const out = new Map();
    for (const r of rows) {
        if (!out.has(r.pubkey)) out.set(r.pubkey, []);
        /** @type {unknown} */
        let message = r.message;
        if (r.cid) message = undefined;
        else { try { message = fromJson(JSON.parse(r.message)); } catch (_) { /* fila legacy en texto plano */ } }
        /** @type {import('./types/index.js').QueuedItem[]} */ (out.get(r.pubkey)).push({
            id: r.id,
            from: r.from_token,
            fromPubkey: r.from_pubkey,
            ...(r.cid ? { cid: r.cid } : { message }),
            queuedAt: r.queued_at,
            expiresAt: r.expires_at,
            bytes: r.bytes,
            app: r.app || null
        });
    }
    return out;
}

// Inserta una fila y devuelve su id (para poder borrarla luego en flush/evict).
/**
 * @param {string} pubkey
 * @param {import('./types/index.js').QueuedItem} item
 * @returns {number} el id de la fila
 */
function insertQueued(pubkey, item) {
    // `message` puede ser objeto; SQLite solo bindea texto/números → serializamos
    // siempre a JSON (y se parsea al rehidratar). Round-trip estable.
    // Un cuerpo en bytes (body.js) va en base64 marcado: JSON.stringify de un Buffer lo
    // escribiría como una lista de números.
    const msgText = item.cid ? 'null' : JSON.stringify(toJson(item.message));
    const info = getDb().prepare(`
        INSERT INTO offline_queue (pubkey, from_token, from_pubkey, message, queued_at, expires_at, bytes, app, cid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(pubkey, item.from || null, item.fromPubkey || null, msgText, item.queuedAt, item.expiresAt, item.bytes || 0, item.app || null, item.cid || null);
    return Number(info.lastInsertRowid);
}

/** @param {number[] | null | undefined} ids */
function deleteQueuedByIds(ids) {
    if (!ids || !ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    getDb().prepare(`DELETE FROM offline_queue WHERE id IN (${placeholders})`).run(...ids);
}

/** @param {string} pubkey */
function deleteQueuedForPubkey(pubkey) {
    getDb().prepare('DELETE FROM offline_queue WHERE pubkey = ?').run(pubkey);
}

/** @param {number} now */
function deleteExpired(now) {
    getDb().prepare('DELETE FROM offline_queue WHERE expires_at < ?').run(now);
}

// ----- scheduled pushes (auto-recordatorios; target = owner pubkey) ------

/**
 * @param {{ pubkey: string, app?: string | null, payload?: string | null, nextFire: number, cron?: string | null, tz?: string | null }} p
 * @returns {number} el id de la fila
 */
function insertScheduledPush({ pubkey, app, payload, nextFire, cron, tz }) {
    const now = Date.now();
    const info = getDb().prepare(`
        INSERT INTO scheduled_pushes (pubkey, app, payload, next_fire, cron, tz, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(pubkey, app || null, payload || null, nextFire, cron || null, tz || null, now, now);
    return Number(info.lastInsertRowid);
}

/**
 * @param {string} pubkey
 * @returns {import('./types/index.js').ScheduledPushRow[]}
 */
function listScheduledPushesForPubkey(pubkey) {
    return /** @type {import('./types/index.js').ScheduledPushRow[]} */ (/** @type {unknown} */ (getDb().prepare(`
        SELECT id, pubkey, app, payload, next_fire, cron, tz, created_at, updated_at
        FROM scheduled_pushes WHERE pubkey = ? ORDER BY next_fire ASC
    `).all(pubkey)));
}

/**
 * @param {number} id
 * @returns {import('./types/index.js').ScheduledPushRow | undefined}
 */
function getScheduledPush(id) {
    return /** @type {import('./types/index.js').ScheduledPushRow | undefined} */ (getDb().prepare('SELECT * FROM scheduled_pushes WHERE id = ?').get(id));
}

/** @param {number} id */
function deleteScheduledPush(id) {
    getDb().prepare('DELETE FROM scheduled_pushes WHERE id = ?').run(id);
}

/** @param {number} id @param {number} nextFire */
function updateScheduledPushNextFire(id, nextFire) {
    getDb().prepare('UPDATE scheduled_pushes SET next_fire = ?, updated_at = ? WHERE id = ?')
        .run(nextFire, Date.now(), id);
}

/**
 * @param {number} now
 * @returns {import('./types/index.js').ScheduledPushRow[]}
 */
function loadDueScheduledPushes(now) {
    return /** @type {import('./types/index.js').ScheduledPushRow[]} */ (/** @type {unknown} */ (getDb().prepare('SELECT * FROM scheduled_pushes WHERE next_fire <= ? ORDER BY next_fire ASC').all(now)));
}

// ----- peer_nodes (federación: identidad pineada de cada proxy peer) -----
// Se pinea la primera vez que el peer se anuncia por GET /node. El `node_id` se
// DERIVA de la pubkey, así que dos ids iguales significan la misma llave: no hay
// conflicto de "id tomado" que resolver. Lo que sí se rechaza es que un mismo
// URL vuelva con otra pubkey; un cambio legítimo de llave se hace a mano
// (borrando la fila), que es exactamente cuando el operador quiere enterarse.

/** @returns {import('./types/index.js').PeerNodeRow[]} */
function loadPeerNodes() {
    return /** @type {import('./types/index.js').PeerNodeRow[]} */ (/** @type {unknown} */ (getDb().prepare('SELECT url, pubkey, node_id, pinned_at, updated_at FROM peer_nodes').all()));
}

/**
 * @param {string} url
 * @param {string} pubkey
 * @param {string} nodeId
 * @param {number} now
 */
function pinPeerNode(url, pubkey, nodeId, now) {
    getDb().prepare(`
        INSERT INTO peer_nodes (url, pubkey, node_id, pinned_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(url, pubkey, nodeId, now, now);
}

/** @param {string} url @param {number} now */
function touchPeerNode(url, now) {
    getDb().prepare('UPDATE peer_nodes SET updated_at = ? WHERE url = ?').run(now, url);
}

/** @param {string} url */
function deletePeerNode(url) {
    getDb().prepare('DELETE FROM peer_nodes WHERE url = ?').run(url);
}

module.exports = {
    init,
    getMeta,
    setMeta,
    loadPeerNodes,
    pinPeerNode,
    touchPeerNode,
    deletePeerNode,
    insertScheduledPush,
    listScheduledPushesForPubkey,
    getScheduledPush,
    deleteScheduledPush,
    updateScheduledPushNextFire,
    loadDueScheduledPushes,
    loadPushSubscriptions,
    upsertPushSubscription,
    deletePushSubscription,
    loadOfflineQueue,
    insertQueued,
    deleteQueuedByIds,
    deleteQueuedForPubkey,
    deleteExpired,
    upsertHome,
    loadHomes,
    deleteExpiredHomes,
    upsertEncPub,
    loadEncPubs,
    deleteExpiredEncPubs,
};
