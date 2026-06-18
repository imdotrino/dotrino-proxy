'use strict';

// Persistencia durable del proxy usando el SQLite nativo de Node (node:sqlite,
// Node >= 22.5). Solo persistimos lo que NO es efímero:
//   - push_subscriptions: pubkey -> PushSubscription (perderlas = no timbrar)
//   - offline_queue: mensajes encolados 24h para destinatarios offline
//
// Los mapas token<->pubkey y los canales públicos NO se persisten: son
// efímeros por diseño (el token cambia en cada conexión, los canales expiran).
//
// Modelo write-through: server.js mantiene los Maps en RAM como working set y
// llama a estas funciones para reflejar cada cambio en disco. Al arrancar,
// `loadOfflineQueue()` y `loadPushSubscriptions()` rehidratan los Maps.

const { DatabaseSync } = require('node:sqlite');

let db = null;

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
            pubkey       TEXT PRIMARY KEY,
            subscription TEXT NOT NULL,
            updated_at   INTEGER NOT NULL
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
    `);
    return db;
}

// ----- home registrations (federación: "soy el home de esta pubkey") -----
// Se upsertea en cada identify; con TTL para olvidar identidades que ya no usan
// este proxy. Permite que, al recibir un mensaje federado, sólo el HOME encole.

function upsertHome(pubkey, now) {
    db.prepare(`
        INSERT INTO home_registrations (pubkey, updated_at) VALUES (?, ?)
        ON CONFLICT(pubkey) DO UPDATE SET updated_at = excluded.updated_at
    `).run(pubkey, now);
}

function loadHomes(minUpdatedAt) {
    return db.prepare('SELECT pubkey FROM home_registrations WHERE updated_at >= ?')
        .all(minUpdatedAt).map(r => r.pubkey);
}

function deleteExpiredHomes(cutoff) {
    db.prepare('DELETE FROM home_registrations WHERE updated_at < ?').run(cutoff);
}

// ----- meta (clave-valor para config persistida, p.ej. VAPID) ------------

function getMeta(key) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
}

function setMeta(key, value) {
    db.prepare(`
        INSERT INTO meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
}

// ----- push subscriptions ------------------------------------------------

function loadPushSubscriptions() {
    const rows = db.prepare('SELECT pubkey, subscription FROM push_subscriptions').all();
    const out = new Map();
    for (const r of rows) {
        try { out.set(r.pubkey, JSON.parse(r.subscription)); } catch (_) {}
    }
    return out;
}

function upsertPushSubscription(pubkey, subscription) {
    db.prepare(`
        INSERT INTO push_subscriptions (pubkey, subscription, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(pubkey) DO UPDATE SET subscription = excluded.subscription, updated_at = excluded.updated_at
    `).run(pubkey, JSON.stringify(subscription), Date.now());
}

function deletePushSubscription(pubkey) {
    db.prepare('DELETE FROM push_subscriptions WHERE pubkey = ?').run(pubkey);
}

// ----- offline queue -----------------------------------------------------

// Devuelve Map<pubkey, Array<item>> donde item incluye su `id` de fila.
function loadOfflineQueue(now) {
    db.prepare('DELETE FROM offline_queue WHERE expires_at < ?').run(now);
    const rows = db.prepare(`
        SELECT id, pubkey, from_token, from_pubkey, message, queued_at, expires_at, bytes
        FROM offline_queue ORDER BY id ASC
    `).all();
    const out = new Map();
    for (const r of rows) {
        if (!out.has(r.pubkey)) out.set(r.pubkey, []);
        let message = r.message;
        try { message = JSON.parse(r.message); } catch (_) { /* fila legacy en texto plano */ }
        out.get(r.pubkey).push({
            id: r.id,
            from: r.from_token,
            fromPubkey: r.from_pubkey,
            message,
            queuedAt: r.queued_at,
            expiresAt: r.expires_at,
            bytes: r.bytes
        });
    }
    return out;
}

// Inserta una fila y devuelve su id (para poder borrarla luego en flush/evict).
function insertQueued(pubkey, item) {
    // `message` puede ser objeto; SQLite solo bindea texto/números → serializamos
    // siempre a JSON (y se parsea al rehidratar). Round-trip estable.
    const msgText = JSON.stringify(item.message);
    const info = db.prepare(`
        INSERT INTO offline_queue (pubkey, from_token, from_pubkey, message, queued_at, expires_at, bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(pubkey, item.from || null, item.fromPubkey || null, msgText, item.queuedAt, item.expiresAt, item.bytes || 0);
    return Number(info.lastInsertRowid);
}

function deleteQueuedByIds(ids) {
    if (!ids || !ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM offline_queue WHERE id IN (${placeholders})`).run(...ids);
}

function deleteQueuedForPubkey(pubkey) {
    db.prepare('DELETE FROM offline_queue WHERE pubkey = ?').run(pubkey);
}

function deleteExpired(now) {
    db.prepare('DELETE FROM offline_queue WHERE expires_at < ?').run(now);
}

// ----- scheduled pushes (auto-recordatorios; target = owner pubkey) ------

function insertScheduledPush({ pubkey, payload, nextFire, cron, tz }) {
    const now = Date.now();
    const info = db.prepare(`
        INSERT INTO scheduled_pushes (pubkey, payload, next_fire, cron, tz, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(pubkey, payload || null, nextFire, cron || null, tz || null, now, now);
    return Number(info.lastInsertRowid);
}

function listScheduledPushesForPubkey(pubkey) {
    return db.prepare(`
        SELECT id, pubkey, payload, next_fire, cron, tz, created_at, updated_at
        FROM scheduled_pushes WHERE pubkey = ? ORDER BY next_fire ASC
    `).all(pubkey);
}

function getScheduledPush(id) {
    return db.prepare('SELECT * FROM scheduled_pushes WHERE id = ?').get(id);
}

function deleteScheduledPush(id) {
    db.prepare('DELETE FROM scheduled_pushes WHERE id = ?').run(id);
}

function updateScheduledPushNextFire(id, nextFire) {
    db.prepare('UPDATE scheduled_pushes SET next_fire = ?, updated_at = ? WHERE id = ?')
        .run(nextFire, Date.now(), id);
}

function loadDueScheduledPushes(now) {
    return db.prepare('SELECT * FROM scheduled_pushes WHERE next_fire <= ? ORDER BY next_fire ASC').all(now);
}

module.exports = {
    init,
    getMeta,
    setMeta,
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
};
