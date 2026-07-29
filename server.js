require('dotenv').config();
const http = require('http');
const WebSocket = require('ws');
const tokenManager = require('./tokenManager');
const { createRateLimiter } = require('./rateLimiter');
const { createUsageStats } = require('./usageStats');
const { createTurnIssuer } = require('./turnCredentials');
const usageStats = createUsageStats();
const crypto = require('crypto');

// Configuración
const PORT = parseInt(process.env.PORT) || 4001;

// Almacenar conexiones activas: token -> {ws, ip, channel, connectedAt}
const activeConnections = new Map();

// Almacenar pares de conexión que se han comunicado
// Formato: "token1:token2" (tokens ordenados alfabéticamente)
const connectionPairs = new Set();

// Almacenar canales públicos: channel -> [{token, publishedAt}, ...]
const publicChannels = new Map();
const MAX_CHANNEL_ENTRIES = 100;
const CHANNEL_ENTRY_EXPIRY_MS = 20 * 60 * 1000; // 20 minutos

// Observadores read-only de un canal: channel -> Set<token>. Reciben los eventos
// joined/left/disconnected del canal SIN figurar como miembros (no aparecen en
// list()). Pensado para el lobby: ver altas/bajas de salas en vivo sin tener que
// publicarse como una sala fantasma. (No persistente: se limpia al desconectar.)
const channelWatchers = new Map();

// ----- Identidad opt-in y cola offline ----------------------------------
//
// Un cliente puede llamar a `identify` enviando un sobre firmado
// `{ op:'identify', token, ts }`. Eso enlaza su pubkey ECDSA con la
// conexión actual. Una vez identificado, otros clientes pueden direccionar
// mensajes por pubkey usando `to_publickey: [pk]`. Si el destinatario está
// online, se entrega de inmediato; si no, el mensaje queda encolado hasta
// 24h y se entrega cuando el destinatario vuelva a identificarse.
//
// Estado en memoria (sin disco). Tope global para no crecer sin límite.

// Una pubkey puede estar identificada simultáneamente desde varias
// conexiones (multi-instancia: web + extensión, dos pestañas, móvil...);
// los mensajes online se hacen fan-out a todos los tokens activos.
// La cola offline sigue siendo 1 sola por pubkey: el primer cliente que
// identifique drena la cola completa y se borra (los demás no la verán).
const pubkeyToTokens = new Map();   // publickey JWK string -> Set<token>
const tokenToPubkey = new Map();    // token -> publickey JWK string (1:1)
const tokenToExtraPubkeys = new Map(); // token -> Set<pubkey> (bindings DELEGADOS por cert, p.ej. la maestra M)

// Persistencia durable (SQLite nativo). Solo lo no-efímero: la cola offline y
// las push subscriptions. Los Maps en RAM son el working set; SQLite el
// respaldo (write-through). Los mapas token<->pubkey NO se persisten.
const persist = require('./persistence');
const DB_FILE = process.env.PROXY_DB_FILE || './proxy-data.db';
persist.init(DB_FILE);

const OFFLINE_TTL_MS = 24 * 60 * 60 * 1000;          // 1 día
const IDENTIFY_TS_TOLERANCE_MS = 5 * 60 * 1000;       // ±5 min

// --- Federación s2s (opcional): reenviar mensajes por pubkey a proxies peer. ---
// Apagada si PROXY_PEERS está vacío → el proxy se comporta EXACTAMENTE como antes.
const PROXY_PEERS = (process.env.PROXY_PEERS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
const PROXY_PUBLIC_URL = (process.env.PROXY_PUBLIC_URL || '').trim().replace(/\/+$/, '') || null;
const HOME_TTL_MS = Number(process.env.PROXY_HOME_TTL_MS || 7 * 24 * 60 * 60 * 1000); // 7 días

// Identidad criptográfica de ESTE nodo (llave del vault) + registro de peers.
// Sustituye al secreto simétrico `PROXY_FEDERATION_TOKEN`: cada nodo firma lo que
// manda y el receptor verifica contra la pubkey pineada del emisor, así que un
// nodo no puede hablar en nombre de otro ni hace falta compartir un secreto.
const nodeIdentityLib = require('./nodeIdentity');
const { PeerRegistry } = require('./peers');
const { serviceDir } = require('./vaultSecrets');
let nodeIdentity = null;
try { nodeIdentity = nodeIdentityLib.loadNodeIdentity(serviceDir()); }
catch (e) { console.error('[fed] identidad de nodo inválida:', e.message); }
const peerRegistry = new PeerRegistry({
    urls: PROXY_PEERS, identity: nodeIdentity, persist, log: (...a) => console.log(...a)
});
const s2sReplay = new nodeIdentityLib.ReplayWindow();

// Malla s2s: un WebSocket persistente por peer. Es el camino PRINCIPAL de la
// federación; `POST /federate` queda como reserva para cuando el enlace está
// caído (y para peers que aún no lo hablen).
const { Mesh } = require('./mesh');
const mesh = new Mesh({
    urls: PROXY_PEERS,
    identity: nodeIdentity,
    registry: peerRegistry,
    log: (...a) => console.log(...a),
    onDeliver: (payload) => {
        try {
            const { toPubkey, fromPubkey, message, queuedAt, expiresAt } = payload || {};
            if (typeof toPubkey !== 'string' || message === undefined) return;
            deliverFederated(toPubkey, message, fromPubkey || null, queuedAt, expiresAt);
        } catch (e) { console.warn('[mesh] entrega federada falló:', e.message); }
    }
});
// "Soy el home de estas pubkeys" (identificaron acá). Set en RAM + respaldo SQLite.
const homePubkeys = new Set(persist.loadHomes(Date.now() - HOME_TTL_MS));
function registerHome(pubkey) {
    homePubkeys.add(pubkey);
    try { persist.upsertHome(pubkey, Date.now()); } catch (_) {}
}
// ¿Este proxy es responsable de encolar para pubkey? (identificó acá, o está online acá)
function isHome(pubkey) { return homePubkeys.has(pubkey) || pubkeyToTokens.has(pubkey); }

// Reenvía un mensaje por pubkey a todos los peers (fire-and-forget). El payload
// va opaco (cifrado E2E por el cliente); los proxies son tránsito ciego.
// El sobre va FIRMADO con la llave de este nodo: el receptor sabe quién se lo
// mandó sin que haya ningún secreto compartido de por medio. `ts` + `nonce`
// cierran el replay (una trama capturada no se puede reenviar indefinidamente).
function forwardToPeers(toPubkey, msgBody, fromPubkey, queuedAt, expiresAt) {
    if (!PROXY_PEERS.length) return;
    if (!nodeIdentity) return;  // sin identidad no se puede firmar → no se federa

    // Camino principal: la malla. Va ordenado por socket, con acuse y reenvío
    // tras reconectar, y funciona aunque el peer esté detrás de NAT.
    //
    // Se usa TAMBIÉN con el enlace caído, a propósito: el link guarda la trama y
    // la manda al reconectar. Preguntar `anyReady()` y caer al POST cuando el
    // peer estaba abajo era justo lo contrario de lo que hace falta — el POST
    // fallaba contra un peer muerto y la trama no quedaba en ningún buffer, así
    // que el mensaje solo existía en la cola local del emisor, donde el
    // destinatario (que vive en OTRO nodo) no lo iba a ver nunca.
    if (mesh.hasLinks()) {
        mesh.broadcastDeliver({ toPubkey, fromPubkey, message: msgBody, queuedAt, expiresAt });
        return;
    }

    // Reserva: POST firmado, para peers configurados sin enlace de malla.
    const body = {
        v: 1, op: 'deliver',
        from: nodeIdentity.pubkey,
        ts: Date.now(),
        nonce: nodeIdentityLib.newNonce(),
        toPubkey, fromPubkey, message: msgBody, queuedAt, expiresAt
    };
    const payload = JSON.stringify({ body, signature: nodeIdentityLib.signBody(nodeIdentity, body) });
    for (const peer of PROXY_PEERS) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        fetch(`${peer}/federate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: payload, signal: ctrl.signal
        }).catch(e => console.warn(`[fed] forward a ${peer} falló:`, e.message)).finally(() => clearTimeout(t));
    }
}

// Aplica un mensaje federado recibido de un peer: entrega a instancias locales,
// o encola SÓLO si este proxy es el home del destinatario. NO re-reenvía (sin loops).
function deliverFederated(toPubkey, msgBody, fromPubkey, queuedAt, expiresAt) {
    const set = pubkeyToTokens.get(toPubkey);
    let delivered = 0;
    if (set) {
        for (const tk of set) {
            const conn = activeConnections.get(tk);
            if (!conn) continue;
            try {
                conn.ws.send(JSON.stringify({ type: 'message', from: null, from_publickey: fromPubkey, message: msgBody }));
                delivered++;
            } catch (_) {}
        }
    }
    if (delivered > 0) return { delivered };
    if (isHome(toPubkey)) {
        const bytes = bytesOfMessage(msgBody);
        enqueueOffline(toPubkey, {
            from: null, fromPubkey, message: msgBody,
            queuedAt: queuedAt || Date.now(),
            expiresAt: expiresAt || (Date.now() + OFFLINE_TTL_MS), bytes
        });
        ringPush(toPubkey);
        return { queued: true };
    }
    return { dropped: true };
}
const MAX_QUEUE_PER_PUBKEY = 200;                     // mensajes
const MAX_BYTES_PER_PUBKEY = 1 * 1024 * 1024;         // 1 MB por destinatario
const MAX_TOTAL_QUEUE_BYTES = 64 * 1024 * 1024;       // 64 MB totales
let totalQueueBytes = 0;

// publickey -> array<QueuedMsg>. Cada QueuedMsg lleva su `id` de fila SQLite
// para poder borrarlo del disco al entregar/evictar. Se rehidrata al arrancar.
const offlineQueues = persist.loadOfflineQueue(Date.now());
for (const q of offlineQueues.values()) {
    for (const item of q) totalQueueBytes += item.bytes || 0;
}
if (offlineQueues.size) {
    console.log(`[persist] cola offline rehidratada: ${offlineQueues.size} pubkey(s), ${totalQueueBytes} bytes`);
}

function bytesOfMessage(m) {
    try { return Buffer.byteLength(typeof m === 'string' ? m : JSON.stringify(m), 'utf8'); }
    catch (_) { return 0; }
}

function trimQueueByCaps(pubkey) {
    const q = offlineQueues.get(pubkey);
    if (!q) return;
    const droppedIds = [];
    while (q.length > MAX_QUEUE_PER_PUBKEY) {
        const dropped = q.shift();
        totalQueueBytes -= dropped.bytes || 0;
        if (dropped.id != null) droppedIds.push(dropped.id);
    }
    let bytes = q.reduce((a, x) => a + (x.bytes || 0), 0);
    while (bytes > MAX_BYTES_PER_PUBKEY && q.length) {
        const dropped = q.shift();
        bytes -= dropped.bytes || 0;
        totalQueueBytes -= dropped.bytes || 0;
        if (dropped.id != null) droppedIds.push(dropped.id);
    }
    persist.deleteQueuedByIds(droppedIds);
    if (q.length === 0) offlineQueues.delete(pubkey);
}

function evictGloballyIfOverCap() {
    if (totalQueueBytes <= MAX_TOTAL_QUEUE_BYTES) return;
    // Encuentra entradas más viejas a través de todas las colas y descarta
    // hasta volver bajo el límite.
    const droppedIds = [];
    while (totalQueueBytes > MAX_TOTAL_QUEUE_BYTES) {
        let oldestPk = null;
        let oldestTs = Infinity;
        for (const [pk, q] of offlineQueues) {
            if (q.length && q[0].queuedAt < oldestTs) {
                oldestTs = q[0].queuedAt;
                oldestPk = pk;
            }
        }
        if (!oldestPk) break;
        const dropped = offlineQueues.get(oldestPk).shift();
        totalQueueBytes -= dropped.bytes || 0;
        if (dropped.id != null) droppedIds.push(dropped.id);
        if (offlineQueues.get(oldestPk).length === 0) offlineQueues.delete(oldestPk);
    }
    persist.deleteQueuedByIds(droppedIds);
}

function enqueueOffline(recipientPubkey, queued) {
    // Persistir primero para obtener el id de fila; así un evict/flush posterior
    // puede borrarlo del disco.
    queued.id = persist.insertQueued(recipientPubkey, queued);
    if (!offlineQueues.has(recipientPubkey)) offlineQueues.set(recipientPubkey, []);
    offlineQueues.get(recipientPubkey).push(queued);
    totalQueueBytes += queued.bytes || 0;
    trimQueueByCaps(recipientPubkey);
    evictGloballyIfOverCap();
}

function flushOfflineFor(pubkey, ws) {
    const q = offlineQueues.get(pubkey);
    if (!q || q.length === 0) return 0;
    const now = Date.now();
    let delivered = 0;
    for (const item of q) {
        if (item.expiresAt < now) continue;
        try {
            ws.send(JSON.stringify({
                type: 'message',
                from: item.from,
                from_publickey: item.fromPubkey || null,
                message: item.message,
                queued: true,
                queued_at: new Date(item.queuedAt).toISOString()
            }));
            delivered++;
        } catch (_) { /* ws not writable, give up — keep queue for next time */
            return delivered;
        }
        totalQueueBytes -= item.bytes || 0;
    }
    // Entregada (o expirada) toda la cola de esta pubkey: borrar de RAM y disco.
    offlineQueues.delete(pubkey);
    persist.deleteQueuedForPubkey(pubkey);
    return delivered;
}

function cleanupOfflineQueues() {
    const now = Date.now();
    for (const [pk, q] of Array.from(offlineQueues.entries())) {
        let i = 0;
        const expiredIds = [];
        while (i < q.length && q[i].expiresAt < now) {
            totalQueueBytes -= q[i].bytes || 0;
            if (q[i].id != null) expiredIds.push(q[i].id);
            i++;
        }
        if (i > 0) q.splice(0, i);
        persist.deleteQueuedByIds(expiredIds);
        if (q.length === 0) offlineQueues.delete(pk);
    }
    persist.deleteExpired(now);
}

function bindPubkey(publickey, token) {
    if (!pubkeyToTokens.has(publickey)) pubkeyToTokens.set(publickey, new Set());
    pubkeyToTokens.get(publickey).add(token);
    tokenToPubkey.set(token, publickey);
}

function unbindPubkeyFromToken(token) {
    unbindExtraPubkeys(token);
    const pk = tokenToPubkey.get(token);
    if (!pk) return;
    tokenToPubkey.delete(token);
    const set = pubkeyToTokens.get(pk);
    if (set) {
        set.delete(token);
        if (set.size === 0) pubkeyToTokens.delete(pk);
    }
}

// "Una identidad": además de su pubkey D, una conexión puede quedar bound a la pubkey
// MAESTRA M si presenta un cert válido (D delegado por M). Así los mensajes dirigidos a
// M llegan a este dispositivo. La privada de M NUNCA interviene (el cert es offline-verificable).
function bindExtraPubkey(publickey, token) {
    if (!pubkeyToTokens.has(publickey)) pubkeyToTokens.set(publickey, new Set());
    pubkeyToTokens.get(publickey).add(token);
    if (!tokenToExtraPubkeys.has(token)) tokenToExtraPubkeys.set(token, new Set());
    tokenToExtraPubkeys.get(token).add(publickey);
}

function unbindExtraPubkeys(token) {
    const set = tokenToExtraPubkeys.get(token);
    if (!set) return;
    for (const pk of set) {
        const s = pubkeyToTokens.get(pk);
        if (s) { s.delete(token); if (s.size === 0) pubkeyToTokens.delete(pk); }
    }
    tokenToExtraPubkeys.delete(token);
}

// Verifica un cert de delegación (D delegado por M). Devuelve M (cert.iss) si es válido y
// delega EXACTAMENTE a `deviceJwkStr`, o null. Reusa la verificación de firma del proxy
// (mismo canónico que @dotrino/identity). NO chequea revocación: esa lista vive en el vault
// y el cert caduca solo (tope 30d) → un cert revocado-pero-vigente solo enrutaría a M hasta exp.
function verifyDeviceCert(cert, deviceJwkStr) {
    if (!cert || typeof cert !== 'object') return null;
    const { v, iss, sub, scope, iat, exp, nonce, sig } = cert;
    if (v !== 1 || typeof iss !== 'string' || typeof sub !== 'string' || typeof sig !== 'string') return null;
    if (sub !== deviceJwkStr) return null;            // el cert es para ESTE dispositivo
    if (typeof iat !== 'number' || typeof exp !== 'number') return null;
    const now = Date.now();
    if (now > exp || now < iat - 5 * 60 * 1000) return null;   // vigente
    let issJwk; try { issJwk = JSON.parse(iss); } catch { return null; }
    if (!verifySignatureWithJWK({ v, iss, sub, scope, iat, exp, nonce }, sig, issJwk)) return null;  // firmado por M
    return iss;
}

// "Un perfil, muchas llaves": el ACTA DE PERFIL dice qué llaves son de la misma persona.
// Si el cliente la presenta al identificarse, este proxy la verifica (va firmada por quien
// la selló) y registra el token TAMBIÉN bajo el `profileId` → escribirle a la PERSONA llega
// a cualquiera de sus dispositivos, sin que ninguna llave privada intervenga.
//
// El proxy no decide nada de política: solo comprueba que el acta esté bien firmada y que
// quien se identifica sea miembro. Si mienten, lo peor que consiguen es enrutarse mensajes
// a sí mismos. Ver `dotrino-vault/docs/acta-de-perfil.md`.
function verifyActaMembership(acta, deviceJwkStr) {
    if (!acta || typeof acta !== 'object' || acta.v !== 1) return null;
    const { profileId, sealer, sealedBy, members, sig } = acta;
    if (typeof profileId !== 'string' || typeof sealer !== 'string' || typeof sealedBy !== 'string') return null;
    if (typeof sig !== 'string' || !Array.isArray(members)) return null;
    if (!members.some(m => m && m.pub === deviceJwkStr)) return null;   // quien habla es miembro
    let sealerJwk; try { sealerJwk = JSON.parse(sealedBy); } catch { return null; }
    // El cuerpo firmado es el acta SIN `sig` y SIN `card` — tiene que coincidir exactamente
    // con `actaBody()` de @dotrino/identity/acta, que es quien la firma. La tarjeta va aparte
    // porque lleva su propia firma y se comparte sola.
    const { sig: _omit, card: _card, ...body } = acta;
    if (!verifySignatureWithJWK(body, sig, sealerJwk)) return null;     // firmada por quien dice
    return profileId;
}

// ----- Web Push ("timbre" para destinatarios offline) --------------------
//
// Cuando un mensaje cae a la cola offline, además de encolarlo enviamos un
// Web Push *sin contenido de usuario* ("ring") para que el Service Worker del
// destinatario despierte, reconecte al proxy y baje su cola cifrada. El push
// pasa por el push service del navegador (FCM en Android), que ve solo el
// metadato del timbre, nunca el contenido. NO usamos el SDK de Firebase: solo
// el Web Push Protocol estándar con VAPID. La subscription la controla la PWA
// (subscribe/unsubscribe firmados); aquí solo guardamos la copia que el
// servidor necesita para poder timbrar. Persiste en SQLite (ver persistence.js).
const webpush = require('web-push');

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@dotrino.com';

// Resolución de claves VAPID, en orden de prioridad:
//   1. .env (VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY) — control explícito.
//   2. Par persistido en SQLite (meta) de un arranque anterior.
//   3. Autogenerar una vez y persistir. Así el proxy es zero-config y las
//      claves se mantienen ESTABLES entre reinicios (regenerarlas invalidaría
//      todas las subscriptions existentes).
function resolveVapidKeys() {
    const envPub = process.env.VAPID_PUBLIC_KEY || '';
    const envPriv = process.env.VAPID_PRIVATE_KEY || '';
    if (envPub && envPriv) {
        return { publicKey: envPub, privateKey: envPriv, source: '.env' };
    }
    const storedPub = persist.getMeta('vapid_public_key');
    const storedPriv = persist.getMeta('vapid_private_key');
    if (storedPub && storedPriv) {
        return { publicKey: storedPub, privateKey: storedPriv, source: 'sqlite' };
    }
    const gen = webpush.generateVAPIDKeys();
    persist.setMeta('vapid_public_key', gen.publicKey);
    persist.setMeta('vapid_private_key', gen.privateKey);
    return { publicKey: gen.publicKey, privateKey: gen.privateKey, source: 'autogenerado' };
}

const _vapid = resolveVapidKeys();
const VAPID_PUBLIC_KEY  = _vapid.publicKey;
const VAPID_PRIVATE_KEY = _vapid.privateKey;
const pushEnabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushEnabled) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    console.log(`[push] Web Push habilitado (VAPID ${_vapid.source}).`);
} else {
    console.warn('[push] VAPID no disponible: el timbre push queda deshabilitado (la cola offline sigue funcionando).');
}

// publickey JWK string -> PushSubscription. Working set en RAM, respaldado en
// SQLite (write-through). Rehidratado al arrancar.
const pushSubscriptions = persist.loadPushSubscriptions();
if (pushSubscriptions.size) {
    console.log(`[push] ${pushSubscriptions.size} subscription(s) rehidratadas de SQLite`);
}

function setPushSubscription(pubkey, subscription) {
    pushSubscriptions.set(pubkey, subscription);
    persist.upsertPushSubscription(pubkey, subscription);
}

function removePushSubscription(pubkey) {
    if (pushSubscriptions.delete(pubkey)) persist.deletePushSubscription(pubkey);
}

// Dispara el "timbre" (sin contenido). Best-effort: si la subscription está
// muerta (404/410) la borramos; el mensaje ya quedó encolado de todos modos.
function ringPush(pubkey, extra) {
    if (!pushEnabled) return;
    const sub = pushSubscriptions.get(pubkey);
    if (!sub) return;
    const payload = JSON.stringify({ type: 'ring', ts: Date.now(), ...(extra || {}) });
    webpush.sendNotification(sub, payload, { TTL: OFFLINE_TTL_MS / 1000 })
        .catch((err) => {
            const code = err && err.statusCode;
            if (code === 404 || code === 410) {
                removePushSubscription(pubkey);
                console.log(`[push] subscription expirada (${code}) borrada para una pubkey`);
            } else {
                console.error('[push] error enviando timbre:', code || err.message);
            }
        });
}

// ----- Push programado (auto-recordatorios) ------------------------------
//
// Un usuario programa un push A SU PROPIA pubkey (one-shot por timestamp o
// recurrente por cron+tz). Como target == firmante, no hay vector de abuso:
// nadie programa pushes a terceros. Al vencer, disparamos el mismo `ringPush`.
// Política de catch-up: "descartar lo vencido" — si el server estuvo caído,
// los one-shot vencidos se borran sin disparar y los recurrentes avanzan al
// próximo futuro (no se dispara nada que venció mientras estábamos abajo).
const { CronExpressionParser } = require('cron-parser');
const SCHED_TICK_MS = Number(process.env.SCHED_TICK_MS) || 30 * 1000;

// Próximo disparo futuro (> from) de una expresión cron en una tz. null si inválida.
function cronNextFire(cron, tz, from) {
    try {
        const it = CronExpressionParser.parse(cron, { currentDate: new Date(from), tz: tz || 'UTC' });
        return it.next().toDate().getTime();
    } catch (e) {
        console.error('[sched] cron inválido:', cron, e.message);
        return null;
    }
}

// Al arrancar: reconciliar jobs vencidos SIN disparar (descartar lo vencido).
function reconcileScheduledPushes() {
    const now = Date.now();
    const due = persist.loadDueScheduledPushes(now);
    for (const job of due) {
        if (job.cron) {
            const next = cronNextFire(job.cron, job.tz, now);
            if (next) persist.updateScheduledPushNextFire(job.id, next);
            else persist.deleteScheduledPush(job.id);
        } else {
            persist.deleteScheduledPush(job.id); // one-shot vencido → descartar
        }
    }
    if (due.length) console.log(`[sched] ${due.length} job(s) vencidos reconciliados al arrancar`);
}

// Tick del scheduler: dispara los jobs vencidos y reprograma/borra.
function runScheduledPushes() {
    const now = Date.now();
    let due;
    try { due = persist.loadDueScheduledPushes(now); } catch (e) { console.error('[sched] load error:', e.message); return; }
    for (const job of due) {
        let extra;
        try { extra = job.payload ? JSON.parse(job.payload) : undefined; } catch (_) { extra = undefined; }
        ringPush(job.pubkey, extra);
        if (job.cron) {
            const next = cronNextFire(job.cron, job.tz, now);
            if (next) persist.updateScheduledPushNextFire(job.id, next);
            else persist.deleteScheduledPush(job.id);
        } else {
            persist.deleteScheduledPush(job.id);
        }
    }
}

// Función para ordenar tokens y crear clave de par
function createPairKey(token1, token2) {
    return token1 < token2 ? `${token1}:${token2}` : `${token2}:${token1}`;
}

// Agregar entrada a un canal público
function addToPublicChannel(channel, token) {
    if (!publicChannels.has(channel)) {
        publicChannels.set(channel, []);
    }
    
    const entries = publicChannels.get(channel);
    const now = Date.now();
    
    // Remover si ya existe para evitar duplicados
    const existingIndex = entries.findIndex(entry => entry.token === token);
    if (existingIndex !== -1) {
        entries.splice(existingIndex, 1);
    }
    
    // Agregar al final
    entries.push({ token, publishedAt: now });
    
    // Mantener solo los últimos MAX_CHANNEL_ENTRIES
    if (entries.length > MAX_CHANNEL_ENTRIES) {
        entries.shift(); // Remover el más antiguo
    }
}

// Remover entrada de un canal público
function removeFromPublicChannel(channel, token) {
    if (!publicChannels.has(channel)) return;
    const entries = publicChannels.get(channel);
    const validEntries = entries.filter(entry => entry.token !== token);
    
    if (validEntries.length === 0) {
        publicChannels.delete(channel);
    } else {
        publicChannels.set(channel, validEntries);
    }
}

// Remover entrada de todos los canales públicos
function removeFromAllPublicChannels(token) {
    for (const [channel, entries] of publicChannels) {
        const validEntries = entries.filter(entry => entry.token !== token);
        if (validEntries.length === 0) {
            publicChannels.delete(channel);
        } else if (validEntries.length !== entries.length) {
            publicChannels.set(channel, validEntries);
        }
    }
}

// Quitar un token de todos los canales que observaba (al desconectar).
function removeFromAllWatchers(token) {
    for (const [channel, set] of channelWatchers) {
        if (set.delete(token) && set.size === 0) channelWatchers.delete(channel);
    }
}

// Obtener tokens no expirados de un canal
function getChannelTokens(channel) {
    if (!publicChannels.has(channel)) {
        return [];
    }
    
    const entries = publicChannels.get(channel);
    const now = Date.now();
    
    // Filtrar entradas expiradas
    const validEntries = entries.filter(entry => 
        now - entry.publishedAt < CHANNEL_ENTRY_EXPIRY_MS
    );
    
    // Actualizar el canal con solo entradas válidas
    publicChannels.set(channel, validEntries);
    
    return validEntries.map(entry => entry.token);
}

// Limpiar entradas expiradas de todos los canales
function cleanupExpiredChannelEntries() {
    const now = Date.now();
    let totalRemoved = 0;
    
    for (const [channel, entries] of publicChannels) {
        const validEntries = entries.filter(entry => 
            now - entry.publishedAt < CHANNEL_ENTRY_EXPIRY_MS
        );
        
        const removed = entries.length - validEntries.length;
        if (removed > 0) {
            totalRemoved += removed;
            publicChannels.set(channel, validEntries);
        }
        
        // Eliminar canal si está vacío
        if (validEntries.length === 0) {
            publicChannels.delete(channel);
        }
    }
    
    if (totalRemoved > 0) {
        console.log(`Limpieza de canales: ${totalRemoved} entradas expiradas removidas`);
    }
}

// Notificar a clientes pareados sobre desconexión
// skipTokens: Set de tokens a excluir (ya notificados por broadcast de canal)
function notifyPairedClients(disconnectedToken, skipTokens = new Set()) {
    const tokensToNotify = new Set();
    const pairsToRemove = [];

    // Buscar todos los pares que incluyen el token desconectado
    for (const pairKey of connectionPairs) {
        const [token1, token2] = pairKey.split(':');
        if (token1 === disconnectedToken || token2 === disconnectedToken) {
            const otherToken = token1 === disconnectedToken ? token2 : token1;
            pairsToRemove.push(pairKey);
            if (!skipTokens.has(otherToken)) {
                tokensToNotify.add(otherToken);
            }
        }
    }

    // Enviar notificación a cada cliente pareado no notificado aún
    for (const token of tokensToNotify) {
        const conn = activeConnections.get(token);
        if (conn && conn.ws.readyState === WebSocket.OPEN) {
            conn.ws.send(JSON.stringify({
                type: 'disconnected',
                token: disconnectedToken,
                timestamp: new Date().toISOString()
            }));
        }
    }

    // Limpiar todos los pares (incluso los ya notificados por canal)
    for (const pairKey of pairsToRemove) {
        connectionPairs.delete(pairKey);
    }

    return tokensToNotify.size;
}

// Notificar a los miembros existentes del canal que un token nuevo se publicó
// Notificar a los observadores read-only de un canal (channelWatchers). Reciben
// el mismo frame que los miembros (joined/left/disconnected) pero no figuran en
// la lista. `excludeToken` evita avisarle al propio sujeto del evento.
function notifyWatchers(channelName, frame, excludeToken) {
    const set = channelWatchers.get(channelName);
    if (!set || set.size === 0) return 0;
    let notified = 0;
    for (const watcherToken of set) {
        if (watcherToken === excludeToken) continue;
        const conn = activeConnections.get(watcherToken);
        if (conn && conn.ws.readyState === WebSocket.OPEN) {
            try { conn.ws.send(JSON.stringify(frame)); notified++; } catch (_) {}
        }
    }
    return notified;
}

function notifyChannelMembersOfJoin(joiningToken, channelName) {
    notifyWatchers(channelName, { type: 'joined', token: joiningToken, channel: channelName, timestamp: new Date().toISOString() }, joiningToken);
    const entries = publicChannels.get(channelName);
    if (!entries) return 0;

    const timestamp = new Date().toISOString();
    let notified = 0;

    for (const entry of entries) {
        if (entry.token === joiningToken) continue;

        const conn = activeConnections.get(entry.token);
        if (conn && conn.ws.readyState === WebSocket.OPEN) {
            conn.ws.send(JSON.stringify({
                type: 'joined',
                token: joiningToken,
                channel: channelName,
                timestamp
            }));
            notified++;
        }
    }

    return notified;
}

// Notificar a los miembros restantes del canal que un token se despublicó
function notifyChannelMembersOfLeave(leavingToken, channelName) {
    notifyWatchers(channelName, { type: 'left', token: leavingToken, channel: channelName, timestamp: new Date().toISOString() }, leavingToken);
    const entries = publicChannels.get(channelName);
    if (!entries) return 0;

    const timestamp = new Date().toISOString();
    let notified = 0;

    for (const entry of entries) {
        if (entry.token === leavingToken) continue;

        const conn = activeConnections.get(entry.token);
        if (conn && conn.ws.readyState === WebSocket.OPEN) {
            conn.ws.send(JSON.stringify({
                type: 'left',
                token: leavingToken,
                channel: channelName,
                timestamp
            }));
            notified++;
        }
    }

    return notified;
}

// Notificar a los miembros de cada canal donde el token estaba publicado
// Devuelve el Set de tokens receptores notificados (para deduplicación con notifyPairedClients)
function notifyChannelMembersOfDisconnect(disconnectedToken) {
    const notified = new Set();
    const timestamp = new Date().toISOString();

    for (const [channelName, entries] of publicChannels) {
        // ¿El token desconectado estaba publicado en este canal?
        const isInChannel = entries.some(entry => entry.token === disconnectedToken);
        if (!isInChannel) continue;

        // Observadores read-only del canal también deben enterarse de la baja.
        notifyWatchers(channelName, { type: 'disconnected', token: disconnectedToken, channel: channelName, timestamp }, disconnectedToken);

        // Notificar a cada miembro restante del canal
        for (const entry of entries) {
            if (entry.token === disconnectedToken) continue;

            const conn = activeConnections.get(entry.token);
            if (conn && conn.ws.readyState === WebSocket.OPEN) {
                conn.ws.send(JSON.stringify({
                    type: 'disconnected',
                    token: disconnectedToken,
                    channel: channelName,
                    timestamp
                }));
                notified.add(entry.token);
            }
        }
    }

    return notified;
}

// Remover par de conexión manualmente y notificar a ambas partes
function removeConnectionPair(token1, token2) {
    const pairKey = createPairKey(token1, token2);
    
    if (!connectionPairs.has(pairKey)) {
        return { success: false, error: 'Los tokens no están pareados' };
    }
    
    // Remover el par
    connectionPairs.delete(pairKey);
    
    // Notificar a ambos clientes si están conectados
    const conn1 = activeConnections.get(token1);
    const conn2 = activeConnections.get(token2);
    
    if (conn1 && conn1.ws.readyState === WebSocket.OPEN) {
        conn1.ws.send(JSON.stringify({
            type: 'disconnected',
            token: token2,
            timestamp: new Date().toISOString()
        }));
    }
    
    if (conn2 && conn2.ws.readyState === WebSocket.OPEN) {
        conn2.ws.send(JSON.stringify({
            type: 'disconnected',
            token: token1,
            timestamp: new Date().toISOString()
        }));
    }
    
    return { success: true, pair: pairKey };
}

// Helper functions para manejar IDs de mensajes
/**
 * Extraer valores de ID de un objeto de mensaje
 * @param {Object} message - El mensaje entrante
 * @returns {Object} Objeto con propiedades id y messageId (undefined si no están presentes)
 */
function extractMessageIds(message) {
    return {
        id: message.id,
        messageId: message.messageId
    };
}

/**
 * Aplicar campos ID de un mensaje a un objeto de respuesta
 * @param {Object} response - El objeto de respuesta a modificar
 * @param {Object} message - El mensaje original
 * @returns {Object} El objeto de respuesta modificado
 */
function applyMessageIds(response, message) {
    if (message.id !== undefined) {
        response.id = message.id;
    }
    if (message.messageId !== undefined) {
        response.messageId = message.messageId;
    }
    return response;
}

/**
 * Emitir abuse_notice ante una violación de soft-limit.
 *
 * Para 'message' (mensaje regular): se notifica a cada destino válido en
 *   `originalMessage.to`, así el receptor puede penalizar localmente al emisor.
 * Para tipos especiales (publish/list/etc.): el "afectado" es el proxy, así
 *   que la notificación vuelve al propio emisor como aviso informativo.
 */
function emitAbuseNotice(senderToken, operation, originalMessage) {
    const notice = {
        type: 'abuse_notice',
        from: senderToken,
        operation,
        severity: 'soft',
        timestamp: new Date().toISOString()
    };

    if (operation === 'message' && originalMessage && originalMessage.to) {
        const targets = Array.isArray(originalMessage.to) ? originalMessage.to : [originalMessage.to];
        for (const targetToken of targets) {
            if (targetToken === senderToken) continue;
            const targetConn = activeConnections.get(targetToken);
            if (targetConn && targetConn.ws.readyState === WebSocket.OPEN) {
                try { targetConn.ws.send(JSON.stringify(notice)); } catch (_) {}
            }
        }
        return;
    }

    // Tipos especiales: notice al propio emisor.
    const senderConn = activeConnections.get(senderToken);
    if (senderConn && senderConn.ws.readyState === WebSocket.OPEN) {
        try { senderConn.ws.send(JSON.stringify(notice)); } catch (_) {}
    }
}

/**
 * Validar formato de canal según nueva especificación
 * Formato esperado: {data: {name: "channelName", publickey: "pubkey", ...}, signature: "datasignature"}
 * @param {Object} channelData - Objeto de canal a validar
 * @returns {Object} Resultado de validación {valid: boolean, error: string, channelName: string}
 */
function validateChannelFormat(channelData) {
    // Validar que el objeto no sea nulo
    if (!channelData || typeof channelData !== 'object') {
        return { valid: false, error: 'Formato de canal inválido: debe ser un objeto' };
    }
    
    // Validar estructura básica
    if (!channelData.data || typeof channelData.data !== 'object') {
        return { valid: false, error: 'Formato de canal inválido: falta campo "data"' };
    }
    
    if (!channelData.signature || typeof channelData.signature !== 'string') {
        return { valid: false, error: 'Formato de canal inválido: falta campo "signature" o no es string' };
    }
    
    // Validar campos requeridos en data
    const data = channelData.data;
    if (!data.name || typeof data.name !== 'string') {
        return { valid: false, error: 'Formato de canal inválido: data.name es requerido y debe ser string' };
    }
    
    if (!data.publickey || typeof data.publickey !== 'string') {
        return { valid: false, error: 'Formato de canal inválido: data.publickey es requerido y debe ser string' };
    }
    
    // Validar longitud máxima de 1000 caracteres para el JSON completo
    const jsonString = JSON.stringify(channelData);
    if (jsonString.length > 1000) {
        return { valid: false, error: `Formato de canal inválido: excede 1000 caracteres (${jsonString.length})` };
    }
    
    // Validar firma
    const signatureValid = validateSignature(channelData);
    
    if (!signatureValid) {
        return { valid: false, error: 'Firma inválida' };
    }
    
    return { valid: true, channelName: data.name };
}

/**
 * Validar firma del canal
 * @param {Object} channelData - Datos del canal
 * @returns {boolean} true si la firma es válida
 */
function validateSignature(channelData) {
    try {
        const signature = channelData && channelData.signature;
        const data = channelData && channelData.data;
        const publicKeyStr = data && data.publickey;
        if (!signature || typeof signature !== 'string' || !signature.trim()) return false;
        if (!publicKeyStr || typeof publicKeyStr !== 'string' || !publicKeyStr.trim()) return false;
        let publicKeyJson;
        try { publicKeyJson = JSON.parse(publicKeyStr); } catch (_) { return false; }
        if (publicKeyJson.kty !== 'EC' || publicKeyJson.crv !== 'P-256') return false;
        // Verificación criptográfica REAL (sin fallbacks de "desarrollo").
        return verifySignatureWithJWK(data, signature, publicKeyJson);
    } catch (_) {
        return false;
    }
}

/**
 * Verificar firma usando clave pública JWK
 * @param {Object} data - Datos a verificar
 * @param {string} signatureBase64 - Firma en base64
 * @param {Object} publicKeyJwk - Clave pública en formato JWK
 * @returns {boolean} true si la firma es válida
 */
function verifySignatureWithJWK(data, signatureBase64, publicKeyJwk) {
    try {
        // ECDSA P-256, firma "raw" r||s de WebCrypto (ieee-p1363), sobre la
        // serialización canónica. ESTRICTO: cualquier error = firma inválida
        // (antes devolvía `true` en error → agujero de spoofing de identidad).
        if (!publicKeyJwk || publicKeyJwk.kty !== 'EC' || publicKeyJwk.crv !== 'P-256' ||
            !publicKeyJwk.x || !publicKeyJwk.y) return false;
        if (typeof signatureBase64 !== 'string' || signatureBase64.length < 10) return false;
        const keyObject = crypto.createPublicKey({
            key: { kty: 'EC', crv: 'P-256', x: publicKeyJwk.x, y: publicKeyJwk.y },
            format: 'jwk'
        });
        return crypto.verify(
            'sha256',
            Buffer.from(canonicalStringify(data), 'utf8'),
            { key: keyObject, dsaEncoding: 'ieee-p1363' },
            Buffer.from(signatureBase64, 'base64')
        );
    } catch (_) {
        return false;
    }
}

/**
 * Stringify object with sorted keys for canonical representation
 * @param {Object} obj Object to stringify
 * @returns {string} Canonical JSON string
 */
function canonicalStringify(obj) {
    if (typeof obj !== 'object' || obj === null) {
        return JSON.stringify(obj);
    }
    
    if (Array.isArray(obj)) {
        return '[' + obj.map(item => canonicalStringify(item)).join(',') + ']';
    }
    
    // Object: sort keys
    const sortedKeys = Object.keys(obj).sort();
    const keyValuePairs = sortedKeys.map(key => {
        return JSON.stringify(key) + ':' + canonicalStringify(obj[key]);
    });
    
    return '{' + keyValuePairs.join(',') + '}';
}

/**
 * Validación básica de firma (para desarrollo/fallback)
 * @param {Object} channelData - Datos del canal
 * @returns {boolean} true si pasa validación básica
 */
function validateSignatureBasic(channelData) {
    const signature = channelData.signature;
    const publicKey = channelData.data.publickey;
    
    // Validaciones básicas para desarrollo
    if (signature.startsWith('FALLBACK-') || signature.startsWith('MOCK-')) {
        return true;
    }
    
    // Verificar que no esté vacía
    if (!signature || signature.trim() === '') return false;
    if (!publicKey || publicKey.trim() === '') return false;
    
    // Verificar formato base64
    const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
    if (!base64Regex.test(signature)) {
        // Podría ser JWK, verificar si es JSON
        try {
            JSON.parse(publicKey);
            // Es JWK, aceptar para desarrollo
            return true;
        } catch {
            return false;
        }
    }
    
    // Longitud mínima razonable
    if (signature.length < 10) {
        return false;
    }
    
    return true;
}

// Crear servidor HTTP básico (WebSocket upgrade + healthcheck + federación s2s)
/**
 * Verifica un sobre s2s: firmado por un peer PINEADO, fresco y no repetido.
 * Devuelve {ok:true, body, peer} o {ok:false, reason}.
 */
function verifyPeerEnvelope(envelope) {
    const body = envelope && envelope.body;
    const signature = envelope && envelope.signature;
    if (!body || !signature || body.v !== 1) return { ok: false, reason: 'sobre s2s malformado' };
    const peer = peerRegistry.byNodePubkey(body.from);
    if (!peer) return { ok: false, reason: 'nodo emisor desconocido (no pineado)' };
    if (!nodeIdentityLib.verifyBody(body, signature, peer.pubkey)) return { ok: false, reason: 'firma s2s inválida' };
    if (!s2sReplay.accept(body.nonce, body.ts)) return { ok: false, reason: 'trama s2s repetida o fuera de ventana' };
    return { ok: true, body, peer };
}

const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        // CORS abierto: /health es una sonda pública (sin datos de usuario) que
        // los clientes consultan cross-origin (messenger.dotrino.com → proxy*).
        // Sin este header el fetch del health-check lo bloquea el navegador.
        res.writeHead(200, {
            'content-type': 'application/json',
            'access-control-allow-origin': '*'
        });
        res.end(JSON.stringify({ ok: true }));
        return;
    }
    // Anuncio autofirmado de este nodo: quién soy (pubkey) y qué prefijo uso.
    // Es lo que un peer baja para pinearme. Público y sin datos de usuario.
    if (req.url === '/node' && req.method === 'GET') {
        const announcement = peerRegistry.selfAnnouncement(PROXY_PUBLIC_URL);
        if (!announcement) { res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'nodo sin identidad (no enrolado al vault)' })); return; }
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify(announcement));
        return;
    }
    // Diagnóstico de la malla: a quién tengo pineado. Sin datos de usuario (los
    // nodos y sus prefijos son públicos, se anuncian en /node). Existe porque el
    // fallo típico de la federación es asimétrico y silencioso: A tiene pineado a
    // B pero B no a A, y desde fuera parece que "a veces no llegan los mensajes".
    if (req.url === '/peers' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify({
            self: nodeIdentity ? { prefix: nodeIdentity.prefix } : null,
            configured: PROXY_PEERS,
            peers: peerRegistry.known().map((p) => ({ url: p.url, prefix: p.prefix })),
            mesh: mesh.stats()
        }));
        return;
    }
    // Federación: un peer nos reenvía un mensaje por pubkey. Lo entregamos a
    // instancias locales o lo encolamos si somos el home. NO re-reenviamos.
    if (req.url === '/federate' && req.method === 'POST') {
        let size = 0; const chunks = [];
        req.on('data', c => { size += c.length; if (size > 2 * 1024 * 1024) { req.destroy(); } else chunks.push(c); });
        req.on('end', () => {
            try {
                const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                // Sin firma válida de un peer PINEADO no se entrega nada: si no,
                // /federate sería un inyector abierto (cualquiera encolaría para
                // cualquier identidad con home acá). Antes esto lo guardaba un
                // secreto simétrico compartido, que no distinguía QUÉ nodo hablaba.
                const check = verifyPeerEnvelope(envelope);
                if (!check.ok) { res.writeHead(401, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: check.reason })); return; }
                const { toPubkey, fromPubkey, message, queuedAt, expiresAt } = check.body;
                if (typeof toPubkey !== 'string' || message === undefined) { res.writeHead(400); res.end(); return; }
                const r = deliverFederated(toPubkey, message, fromPubkey || null, queuedAt, expiresAt);
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: true, ...r }));
            } catch (_) { res.writeHead(400); res.end(); }
        });
        req.on('error', () => { try { res.writeHead(400); res.end(); } catch (_) {} });
        return;
    }
    // Para cualquier otra ruta, 404 (el proxy es WebSocket; no expone HTTP).
    res.writeHead(404);
    res.end();
});

// Crear servidor WebSocket adjunto al servidor HTTP
// `maxPayload`: sin él, `ws` acepta frames de cualquier tamaño y una sola conexión
// anónima podía reservar cientos de MB antes de que el rate limiter llegara a verla
// (el límite se cobra DESPUÉS de recibir el frame entero). 1 MB es holgado para el
// tráfico real del ecosistema: el tope por destinatario de la cola offline ya es 1 MB
// (MAX_BYTES_PER_PUBKEY) y el túnel del ecosistema usa el mismo número.
const MAX_FRAME_BYTES = Number(process.env.PROXY_MAX_FRAME_BYTES || 1024 * 1024);
// Destinatarios máximos por mensaje (`to` + `to_publickey` sumados). El fan-out
// más grande del ecosistema real es una sala de canal, muy por debajo de 64.
const MAX_FANOUT_PER_MESSAGE = Number(process.env.PROXY_MAX_FANOUT || 64);
const wss = new WebSocket.Server({ server, maxPayload: MAX_FRAME_BYTES });

// Rate limiter (puede ser noop si RATE_LIMIT_DISABLED=1)
let rateLimiter = createRateLimiter();

// Credenciales TURN temporales (Cloudflare). Las llaves llegan del VAULT del
// ecosistema si el proxy está enrolado (ver vaultSecrets.js); el .env directo
// (TURN_KEY_ID/TURN_KEY_API_TOKEN) queda como fallback para self-hosters.
// Sin llaves: enabled:false (los clientes quedan STUN-only).
let turnIssuer = createTurnIssuer();
let vaultSecretsHandle = null;

// El proxy es transporte puro (sin secretos en su core): arranca SIEMPRE, y la
// única feature con secretos (TURN) espera al vault. Reintenta para siempre.
function startVaultSecretsLoop(log = console.log) {
    const { startVaultSecrets } = require('./vaultSecrets');
    vaultSecretsHandle = startVaultSecrets({
        log,
        onSecrets: (s) => {
            if (s.TURN_KEY_ID && s.TURN_KEY_API_TOKEN) {
                if (turnIssuer && typeof turnIssuer.destroy === 'function') turnIssuer.destroy();
                turnIssuer = createTurnIssuer({ keyId: s.TURN_KEY_ID, apiToken: s.TURN_KEY_API_TOKEN });
                log('[turn] llaves de Cloudflare cargadas desde el vault: TURN habilitado');
            } else {
                log('[vault] secretos recibidos sin TURN_KEY_ID/TURN_KEY_API_TOKEN: TURN sigue apagado');
            }
        }
    });
    if (vaultSecretsHandle.enabled) {
        log('[vault] proxy enrolado: esperando los secretos del vault (el transporte ya corre)');
    }
}

wss.on('connection', (ws, req) => {
    // Conexión ENTRANTE de otro nodo (malla s2s): no es un cliente, no lleva
    // token ni cuenta para el rate limiter de usuarios. Se atiende aparte.
    if (Mesh.isMeshPath(req.url)) {
        mesh.handleInbound(ws);
        return;
    }

    // Obtener IP del cliente
    const clientIp = req.socket.remoteAddress || '0.0.0.0';

    // Rechazar conexiones desde IPs baneadas
    if (rateLimiter.isIpBanned(clientIp)) {
        const remaining = rateLimiter.banRemainingMs(clientIp);
        try {
            ws.send(JSON.stringify({
                type: 'error',
                error: 'IP banned',
                retry_after_ms: remaining,
                limit_level: 'hard',
                limit_type: 'ip_ban'
            }));
        } catch (_) {}
        ws.close(1008, 'IP banned');
        return;
    }

    // Asignar token corto al cliente
    const token = tokenManager.assignToken(ws, clientIp);
    
    // Almacenar la conexión
    activeConnections.set(token, {
        ws,
        ip: clientIp,
        channel: null,
        channelData: null,
        connectedAt: Date.now()
    });
    
    // Asociar el token con el WebSocket
    ws.token = token;
    
    // Enviar información al cliente
    ws.send(JSON.stringify({
        type: 'connected',
        token: token,
        timestamp: new Date().toISOString()
    }));
    
    usageStats.recordConnection(clientIp);
    if (process.env.NODE_ENV !== 'test') console.log(`Cliente conectado - Token: ${token}, IP: ${clientIp}. Total activos: ${activeConnections.size}`);
    
    // Manejar mensajes recibidos
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());

            // Actualizar actividad del token
            tokenManager.updateTokenActivity(token);

            // Heartbeat de aplicación: el cliente manda `{type:'ping'}` cada ~20s y
            // espera respuesta; sin ella detecta una conexión half-open y reconecta.
            // Respondemos antes del rate-limit (keepalive gratis) y cortamos acá.
            if (message.type === 'ping') {
                try { ws.send(JSON.stringify({ type: 'pong' })); } catch (_) {}
                return;
            }

            // Rate limiting (per-token + per-type, dos niveles)
            const messageType = message.type || 'message';
            const rateCheck = rateLimiter.consume(token, clientIp, messageType);
            usageStats.recordMessage(clientIp, messageType);
            if (rateCheck.status === 'hard_limit') {
                usageStats.recordHardLimit(clientIp, messageType);
                const errorResponse = {
                    type: 'error',
                    error: `Hard rate limit exceeded for ${messageType}`,
                    retry_after_ms: rateCheck.retry_after_ms || 0,
                    limit_level: 'hard',
                    limit_type: rateCheck.limit_type,
                    operation: messageType
                };
                applyMessageIds(errorResponse, message);
                try { ws.send(JSON.stringify(errorResponse)); } catch (_) {}
                // Por defecto los bans están deshabilitados (RATE_LIMIT_BAN_DISABLED):
                // `banIp` es noop, no se cierra la conexión y solo se rechaza ESTE
                // mensaje (throttling "solo rechazo"). Si se habilitan los bans
                // (RATE_LIMIT_BAN_DISABLED=0), un hard-limit banea la IP y corta la
                // conexión: esto es lo que detiene un flood/DOS sostenido.
                rateLimiter.banIp(clientIp);
                if (rateLimiter.isIpBanned(clientIp)) {
                    try { ws.close(1008, 'rate limit'); } catch (_) {}
                }
                return;
            }
            if (rateCheck.status === 'soft_limit') {
                usageStats.recordSoftLimit(clientIp, messageType);
                emitAbuseNotice(token, messageType, message);
                // No return: el mensaje sigue procesándose
            }

            // Manejar mensajes de tipo especial (publish, unpublish, list, disconnect)
            if (message.type === 'publish') {
                handlePublishMessage(ws, message);
                return;
            } else if (message.type === 'unpublish') {
                handleUnpublishMessage(ws, message);
                return;
            } else if (message.type === 'list') {
                handleListMessage(ws, message);
                return;
            } else if (message.type === 'watch') {
                handleWatchMessage(ws, message);
                return;
            } else if (message.type === 'unwatch') {
                handleUnwatchMessage(ws, message);
                return;
            } else if (message.type === 'channel_count') {
                handleChannelCountMessage(ws, message);
                return;
            } else if (message.type === 'list_channels') {
                handleListChannelsMessage(ws, message);
                return;
            } else if (message.type === 'disconnect') {
                handleDisconnectMessage(ws, message);
                return;
            } else if (message.type === 'identify') {
                handleIdentifyMessage(ws, message);
                return;
            } else if (message.type === 'push-subscribe') {
                handlePushSubscribeMessage(ws, message);
                return;
            } else if (message.type === 'push-unsubscribe') {
                handlePushUnsubscribeMessage(ws, message);
                return;
            } else if (message.type === 'turn-credentials') {
                handleTurnCredentialsMessage(ws, message);
                return;
            } else if (message.type === 'push-config') {
                const response = {
                    type: 'push-config',
                    enabled: pushEnabled,
                    vapidPublicKey: pushEnabled ? VAPID_PUBLIC_KEY : null
                };
                applyMessageIds(response, message);
                ws.send(JSON.stringify(response));
                return;
            } else if (message.type === 'schedule-push') {
                handleSchedulePushMessage(ws, message);
                return;
            } else if (message.type === 'cancel-push') {
                handleCancelPushMessage(ws, message);
                return;
            } else if (message.type === 'list-pushes') {
                handleListPushesMessage(ws, message);
                return;
            }
            
            // Mensaje regular (to + message) o (to_publickey + message)
            const hasTokenTo  = message.to        != null;
            const hasPubkeyTo = message.to_publickey != null;
            if ((!hasTokenTo && !hasPubkeyTo) || !message.message) {
                const errorResponse = {
                    type: 'error',
                    error: 'Formato de mensaje inválido. Debe contener "to" o "to_publickey" y "message", o "type" para operaciones especiales'
                };
                applyMessageIds(errorResponse, message);
                ws.send(JSON.stringify(errorResponse));
                return;
            }

            // Tope de destinatarios por mensaje. El rate limiter cobra por FRAME
            // (un `consume` por mensaje recibido), así que sin tope un solo frame
            // permitido podía abanicarse a miles de destinos — y con federación
            // cada destino se convierte además en tráfico hacia los peers. Con
            // tope, el coste de un frame queda acotado por diseño.
            const fanOutCount = (Array.isArray(message.to) ? message.to.length : (hasTokenTo ? 1 : 0))
                + (Array.isArray(message.to_publickey) ? message.to_publickey.length : (hasPubkeyTo ? 1 : 0));
            if (fanOutCount > MAX_FANOUT_PER_MESSAGE) {
                const errorResponse = {
                    type: 'error',
                    error: `Demasiados destinatarios en un mensaje (${fanOutCount}); el máximo es ${MAX_FANOUT_PER_MESSAGE}`
                };
                applyMessageIds(errorResponse, message);
                ws.send(JSON.stringify(errorResponse));
                return;
            }

            // ----- Direccionamiento por publickey (entrega offline 24h) -----
            if (hasPubkeyTo) {
                const targetPubkeys = Array.isArray(message.to_publickey)
                    ? message.to_publickey
                    : [message.to_publickey];
                handlePubkeyAddressedMessage(ws, message, targetPubkeys);
                if (!hasTokenTo) return; // si solo era pubkey-addressed, terminamos
            }

            if (!hasTokenTo) return;
            // Validar que 'to' sea un array
            const targetTokens = Array.isArray(message.to) ? message.to : [message.to];
            
            if (targetTokens.length === 0) {
                const errorResponse = {
                    type: 'error',
                    error: 'El campo "to" debe contener al menos un token destino'
                };
                
                // Incluir ID del mensaje original si existe
                applyMessageIds(errorResponse, message);
                
                ws.send(JSON.stringify(errorResponse));
                return;
            }
            
            // Verificar que el remitente no se incluya a sí mismo
            if (targetTokens.includes(token)) {
                const errorResponse = {
                    type: 'error',
                    error: 'No puedes enviarte mensajes a ti mismo'
                };
                
                // Incluir ID del mensaje original si existe
                applyMessageIds(errorResponse, message);
                
                ws.send(JSON.stringify(errorResponse));
                return;
            }
            
            // Enviar mensaje a cada destino
            let sentCount = 0;
            const failedTokens = [];
            
            for (const targetToken of targetTokens) {
                // Verificar que el token destino exista y esté conectado
                const targetConn = activeConnections.get(targetToken);
                if (!targetConn) {
                    failedTokens.push(targetToken);
                    continue;
                }
                
                // Enviar el mensaje al destinatario
                targetConn.ws.send(JSON.stringify({
                    type: 'message',
                    from: token,
                    message: message.message
                }));
                
                // Registrar el par de conexión
                const pairKey = createPairKey(token, targetToken);
                connectionPairs.add(pairKey);
                
                sentCount++;
            }
            
            // Confirmación al remitente (solo si hay fallos)
            if (failedTokens.length > 0) {
                const response = {
                    type: 'message_sent',
                    sent: sentCount,
                    total: targetTokens.length,
                    failed: failedTokens
                };
                applyMessageIds(response, message);
                ws.send(JSON.stringify(response));
            }
            
        } catch (error) {
            console.error('Error procesando mensaje:', error);
            ws.send(JSON.stringify({
                type: 'error',
                error: 'Error procesando el mensaje. Formato JSON inválido.'
            }));
        }
    });
    
    // Funciones auxiliares para manejar mensajes especiales
    function handlePublishMessage(ws, message) {
        const channelData = message.channel;
        
        // Validar formato del canal
        const validation = validateChannelFormat(channelData);
        if (!validation.valid) {
            const errorResponse = {
                type: 'error',
                error: validation.error
            };
            
            // Incluir ID del mensaje original si existe
            applyMessageIds(errorResponse, message);
            
            ws.send(JSON.stringify(errorResponse));
            return;
        }
        
        const channelName = validation.channelName;
        
        // Actualizar canal del cliente
        const conn = activeConnections.get(token);
        if (conn) {
            conn.channel = channelName;
            conn.channelData = channelData; // Almacenar datos completos del canal
        }
        
        // Agregar a la lista pública del canal
        addToPublicChannel(channelName, token);

        // Notificar a los demás miembros del canal
        const notifiedJoin = notifyChannelMembersOfJoin(token, channelName);

        const response = {
            type: 'published',
            channel: channelName,
            data: channelData.data,
            timestamp: new Date().toISOString()
        };

        // Incluir ID del mensaje original si existe
        applyMessageIds(response, message);

        ws.send(JSON.stringify(response));

        if (process.env.NODE_ENV !== 'test') console.log(`Cliente ${token} publicado en canal: ${channelName}. Notificados ${notifiedJoin} miembros.`);
    }
    
    function handleUnpublishMessage(ws, message) {
        const channelData = message.channel;
        
        // Validar formato del canal
        const validation = validateChannelFormat(channelData);
        if (!validation.valid) {
            const errorResponse = {
                type: 'error',
                error: validation.error
            };
            
            applyMessageIds(errorResponse, message);
            ws.send(JSON.stringify(errorResponse));
            return;
        }
        
        const channelName = validation.channelName;

        // Remover de la lista pública del canal
        removeFromPublicChannel(channelName, token);

        // Notificar a los miembros restantes del canal
        const notifiedLeave = notifyChannelMembersOfLeave(token, channelName);

        // Limpiar datos del canal en la conexión
        const conn = activeConnections.get(token);
        if (conn) {
            conn.channel = null;
            conn.channelData = null;
        }

        const response = {
            type: 'unpublished',
            channel: channelName,
            timestamp: new Date().toISOString()
        };

        applyMessageIds(response, message);
        ws.send(JSON.stringify(response));

        if (process.env.NODE_ENV !== 'test') console.log(`Cliente ${token} despublicado del canal: ${channelName}. Notificados ${notifiedLeave} miembros.`);
    }
    
    function handleListMessage(ws, message) {
        const channelData = message.channel;
        
        // Validar formato del canal
        const validation = validateChannelFormat(channelData);
        if (!validation.valid) {
            const errorResponse = {
                type: 'error',
                error: validation.error
            };
            
            // Incluir ID del mensaje original si existe
            applyMessageIds(errorResponse, message);
            
            ws.send(JSON.stringify(errorResponse));
            return;
        }
        
        const channelName = validation.channelName;
        
        // Obtener tokens del canal (ya filtrados por expiración)
        const tokens = getChannelTokens(channelName);
        
        const response = {
            type: 'channel_list',
            channel: channelName,
            tokens: tokens,
            count: tokens.length,
            maxEntries: MAX_CHANNEL_ENTRIES,
            timestamp: new Date().toISOString()
        };
        
        // Incluir ID del mensaje original si existe
        applyMessageIds(response, message);
        
        ws.send(JSON.stringify(response));
        
        if (process.env.NODE_ENV !== 'test') console.log(`Cliente ${token} solicitó lista del canal ${channelName}: ${tokens.length} tokens`);
    }

    // Observar un canal (read-only): registra interés en sus eventos joined/left/
    // disconnected SIN publicarse como miembro. Devuelve la lista actual de tokens
    // para que el cliente tenga el estado inicial + luego los eventos en vivo.
    function handleWatchMessage(ws, message) {
        const validation = validateChannelFormat(message.channel);
        if (!validation.valid) {
            const e = { type: 'error', error: validation.error };
            applyMessageIds(e, message); ws.send(JSON.stringify(e)); return;
        }
        const channelName = validation.channelName;
        let set = channelWatchers.get(channelName);
        if (!set) { set = new Set(); channelWatchers.set(channelName, set); }
        set.add(token);
        const tokens = getChannelTokens(channelName);
        const response = { type: 'watched', channel: channelName, tokens, count: tokens.length, timestamp: new Date().toISOString() };
        applyMessageIds(response, message);
        ws.send(JSON.stringify(response));
        if (process.env.NODE_ENV !== 'test') console.log(`Cliente ${token} observa el canal ${channelName} (${tokens.length} tokens)`);
    }

    function handleUnwatchMessage(ws, message) {
        const validation = validateChannelFormat(message.channel);
        if (!validation.valid) {
            const e = { type: 'error', error: validation.error };
            applyMessageIds(e, message); ws.send(JSON.stringify(e)); return;
        }
        const channelName = validation.channelName;
        const set = channelWatchers.get(channelName);
        if (set) { set.delete(token); if (set.size === 0) channelWatchers.delete(channelName); }
        const response = { type: 'unwatched', channel: channelName, timestamp: new Date().toISOString() };
        applyMessageIds(response, message);
        ws.send(JSON.stringify(response));
    }

    function handleListChannelsMessage(ws, message) {
        const prefix = (typeof message.prefix === 'string') ? message.prefix : null;
        const now = Date.now();
        const channels = [];

        for (const [name, entries] of publicChannels) {
            if (prefix && !name.startsWith(prefix)) continue;
            const validCount = entries.filter(e => now - e.publishedAt < CHANNEL_ENTRY_EXPIRY_MS).length;
            if (validCount > 0) {
                channels.push({ name, count: validCount });
            }
        }

        const response = {
            type: 'channels_list',
            channels,
            timestamp: new Date().toISOString()
        };

        if (prefix !== null) response.prefix = prefix;
        applyMessageIds(response, message);
        ws.send(JSON.stringify(response));
    }

    function handleChannelCountMessage(ws, message) {
        const channelName = message.channel;

        if (typeof channelName !== 'string' || channelName.length === 0) {
            const errorResponse = {
                type: 'error',
                error: 'channel requerido (string no vacío)'
            };
            applyMessageIds(errorResponse, message);
            ws.send(JSON.stringify(errorResponse));
            return;
        }

        const tokens = getChannelTokens(channelName);

        const response = {
            type: 'channel_count',
            channel: channelName,
            count: tokens.length,
            maxEntries: MAX_CHANNEL_ENTRIES,
            timestamp: new Date().toISOString()
        };

        applyMessageIds(response, message);
        ws.send(JSON.stringify(response));
    }

    function handleDisconnectMessage(ws, message) {
        const targetToken = message.target;
        
        if (!targetToken || typeof targetToken !== 'string') {
            const errorResponse = {
                type: 'error',
                error: 'Token destino requerido (string)'
            };
            
            // Incluir ID del mensaje original si existe
            applyMessageIds(errorResponse, message);
            
            ws.send(JSON.stringify(errorResponse));
            return;
        }
        
        // Verificar que el token destino no sea el mismo
        if (targetToken === token) {
            const errorResponse = {
                type: 'error',
                error: 'No puedes desconectarte de ti mismo'
            };
            
            // Incluir ID del mensaje original si existe
            applyMessageIds(errorResponse, message);
            
            ws.send(JSON.stringify(errorResponse));
            return;
        }
        
        // Verificar que el token destino exista y esté conectado
        const targetConn = activeConnections.get(targetToken);
        if (!targetConn) {
            const errorResponse = {
                type: 'error',
                error: `Token destino ${targetToken} no encontrado o no conectado`
            };
            
            // Incluir ID del mensaje original si existe
            applyMessageIds(errorResponse, message);
            
            ws.send(JSON.stringify(errorResponse));
            return;
        }
        
        // Remover el par de conexión y notificar a ambas partes
        const result = removeConnectionPair(token, targetToken);
        
        if (result.success) {
            // Enviar confirmación al cliente que solicitó la desconexión
            const response = {
                type: 'disconnect_confirmation',
                target: targetToken,
                timestamp: new Date().toISOString()
            };
            
            // Incluir ID del mensaje original si existe
            applyMessageIds(response, message);
            
            ws.send(JSON.stringify(response));
            
            if (process.env.NODE_ENV !== 'test') console.log(`Cliente ${token} desconectó manualmente de ${targetToken}`);
        } else {
            const errorResponse = {
                type: 'error',
                error: result.error
            };
            
            // Incluir ID del mensaje original si existe
            applyMessageIds(errorResponse, message);
            
            ws.send(JSON.stringify(errorResponse));
        }
    }
    
    // ----- identify y direccionamiento por pubkey -----------------------

    function handleIdentifyMessage(ws, message) {
        try {
            const data = message.data;
            const sig  = message.signature;
            if (!data || !sig || data.op !== 'identify' || !data.publickey || !data.token || !data.ts) {
                const errorResponse = {
                    type: 'error',
                    error: 'Formato identify inválido (esperado data:{op:"identify",publickey,token,ts}+signature)'
                };
                applyMessageIds(errorResponse, message);
                ws.send(JSON.stringify(errorResponse));
                return;
            }
            const skew = Math.abs(Date.now() - Number(data.ts));
            if (!Number.isFinite(skew) || skew > IDENTIFY_TS_TOLERANCE_MS) {
                const errorResponse = { type: 'error', error: 'identify ts fuera de la ventana ±5min' };
                applyMessageIds(errorResponse, message);
                ws.send(JSON.stringify(errorResponse));
                return;
            }
            if (data.token !== ws.token) {
                const errorResponse = { type: 'error', error: 'identify.token no coincide con la conexión' };
                applyMessageIds(errorResponse, message);
                ws.send(JSON.stringify(errorResponse));
                return;
            }
            let pubKeyJwk;
            try { pubKeyJwk = JSON.parse(data.publickey); }
            catch (_) {
                const errorResponse = { type: 'error', error: 'identify.publickey debe ser JWK serializado' };
                applyMessageIds(errorResponse, message);
                ws.send(JSON.stringify(errorResponse));
                return;
            }
            const ok = verifySignatureWithJWK(data, sig, pubKeyJwk);
            if (!ok) {
                const errorResponse = { type: 'error', error: 'Firma identify inválida' };
                applyMessageIds(errorResponse, message);
                ws.send(JSON.stringify(errorResponse));
                return;
            }
            // Si este token estaba bound a OTRA pubkey, lo soltamos primero.
            const prevPub = tokenToPubkey.get(ws.token);
            if (prevPub && prevPub !== data.publickey) {
                const oldSet = pubkeyToTokens.get(prevPub);
                if (oldSet) {
                    oldSet.delete(ws.token);
                    if (oldSet.size === 0) pubkeyToTokens.delete(prevPub);
                }
            }
            // Una pubkey puede estar simultáneamente en varios tokens: añadimos
            // a la set en lugar de reemplazar. Solo el primero drena la cola
            // offline; las siguientes instancias no reciben nada antiguo.
            const wasFirstInstance =
                !pubkeyToTokens.has(data.publickey) ||
                pubkeyToTokens.get(data.publickey).size === 0;
            bindPubkey(data.publickey, ws.token);
            // Federación: este proxy queda registrado como "home" de esta pubkey
            // (persistente con TTL), para encolar sus mensajes federados offline.
            registerHome(data.publickey);

            // "Una identidad": si el cliente presenta un CERT que delega ESTA pubkey D desde
            // una maestra M, registramos el token TAMBIÉN bajo M → los mensajes a M llegan a
            // este dispositivo (sin la privada de M). Aditivo: sin cert, idéntico a antes.
            unbindExtraPubkeys(ws.token);
            let masterDelivered = 0;
            let masterBound = null;
            const master = verifyDeviceCert(message.cert, data.publickey);
            if (master && master !== data.publickey) {
                const masterWasFirst = !pubkeyToTokens.has(master) || pubkeyToTokens.get(master).size === 0;
                bindExtraPubkey(master, ws.token);
                registerHome(master);
                masterBound = master;
                if (masterWasFirst) masterDelivered = flushOfflineFor(master, ws);
            }

            // Acta de perfil: bindea también el `profileId` (la PERSONA), de modo que un
            // mensaje dirigido a ella llegue a cualquiera de sus dispositivos conectados.
            let profileBound = null;
            let profileDelivered = 0;
            const profileId = verifyActaMembership(message.acta, data.publickey);
            if (profileId && profileId !== data.publickey && profileId !== masterBound) {
                const profileWasFirst = !pubkeyToTokens.has(profileId) || pubkeyToTokens.get(profileId).size === 0;
                bindExtraPubkey(profileId, ws.token);
                registerHome(profileId);
                profileBound = profileId;
                if (profileWasFirst) profileDelivered = flushOfflineFor(profileId, ws);
            } else if (profileId) {
                profileBound = profileId;
            }

            const delivered = wasFirstInstance ? flushOfflineFor(data.publickey, ws) : 0;
            const response = { type: 'identified', publickey: data.publickey, queued_delivered: delivered + masterDelivered + profileDelivered, master: masterBound, profile: profileBound };
            applyMessageIds(response, message);
            ws.send(JSON.stringify(response));
        } catch (e) {
            console.error('handleIdentifyMessage error:', e);
            try {
                const errorResponse = { type: 'error', error: 'Error interno en identify' };
                applyMessageIds(errorResponse, message);
                ws.send(JSON.stringify(errorResponse));
            } catch (_) {}
        }
    }

    // Registrar/actualizar la push subscription de una pubkey. El sobre va
    // firmado por el vault (misma verificación que identify): la firma prueba
    // que quien envía la subscription es dueño de esa pubkey.
    //   data: { op:'push-subscribe', publickey, subscription, ts }
    function handlePushSubscribeMessage(ws, message) {
        try {
            const data = message.data;
            const sig  = message.signature;
            if (!data || !sig || data.op !== 'push-subscribe' || !data.publickey || !data.subscription || !data.ts) {
                const e = { type: 'error', error: 'Formato push-subscribe inválido (esperado data:{op:"push-subscribe",publickey,subscription,ts}+signature)' };
                applyMessageIds(e, message); ws.send(JSON.stringify(e)); return;
            }
            const skew = Math.abs(Date.now() - Number(data.ts));
            if (!Number.isFinite(skew) || skew > IDENTIFY_TS_TOLERANCE_MS) {
                const e = { type: 'error', error: 'push-subscribe ts fuera de la ventana ±5min' };
                applyMessageIds(e, message); ws.send(JSON.stringify(e)); return;
            }
            let pubKeyJwk;
            try { pubKeyJwk = JSON.parse(data.publickey); }
            catch (_) {
                const e = { type: 'error', error: 'push-subscribe.publickey debe ser JWK serializado' };
                applyMessageIds(e, message); ws.send(JSON.stringify(e)); return;
            }
            if (!verifySignatureWithJWK(data, sig, pubKeyJwk)) {
                const e = { type: 'error', error: 'Firma push-subscribe inválida' };
                applyMessageIds(e, message); ws.send(JSON.stringify(e)); return;
            }
            // La subscription viaja como string JSON (sobre plano => firma canónica
            // idéntica entre cliente/vault/servidor). La parseamos para guardarla.
            let subscription = data.subscription;
            if (typeof subscription === 'string') {
                try { subscription = JSON.parse(subscription); }
                catch (_) {
                    const e = { type: 'error', error: 'push-subscribe.subscription JSON inválido' };
                    applyMessageIds(e, message); ws.send(JSON.stringify(e)); return;
                }
            }
            setPushSubscription(data.publickey, subscription);
            const response = { type: 'push-subscribed', publickey: data.publickey };
            applyMessageIds(response, message);
            ws.send(JSON.stringify(response));
        } catch (e) {
            console.error('handlePushSubscribeMessage error:', e);
        }
    }

    // Borrar la push subscription de una pubkey (la PWA desactiva notifs).
    //   data: { op:'push-unsubscribe', publickey, ts }
    function handlePushUnsubscribeMessage(ws, message) {
        try {
            const data = message.data;
            const sig  = message.signature;
            if (!data || !sig || data.op !== 'push-unsubscribe' || !data.publickey || !data.ts) {
                const e = { type: 'error', error: 'Formato push-unsubscribe inválido' };
                applyMessageIds(e, message); ws.send(JSON.stringify(e)); return;
            }
            const skew = Math.abs(Date.now() - Number(data.ts));
            if (!Number.isFinite(skew) || skew > IDENTIFY_TS_TOLERANCE_MS) {
                const e = { type: 'error', error: 'push-unsubscribe ts fuera de la ventana ±5min' };
                applyMessageIds(e, message); ws.send(JSON.stringify(e)); return;
            }
            let pubKeyJwk;
            try { pubKeyJwk = JSON.parse(data.publickey); }
            catch (_) {
                const e = { type: 'error', error: 'push-unsubscribe.publickey debe ser JWK serializado' };
                applyMessageIds(e, message); ws.send(JSON.stringify(e)); return;
            }
            if (!verifySignatureWithJWK(data, sig, pubKeyJwk)) {
                const e = { type: 'error', error: 'Firma push-unsubscribe inválida' };
                applyMessageIds(e, message); ws.send(JSON.stringify(e)); return;
            }
            removePushSubscription(data.publickey);
            const response = { type: 'push-unsubscribed', publickey: data.publickey };
            applyMessageIds(response, message);
            ws.send(JSON.stringify(response));
        } catch (e) {
            console.error('handlePushUnsubscribeMessage error:', e);
        }
    }

    // Helper: valida sobre firmado por el vault y devuelve la pubkey (o null).
    // Self-only: el target SIEMPRE es data.publickey (quien firma).
    function verifySignedOp(ws, message, op) {
        const data = message.data;
        const sig  = message.signature;
        if (!data || !sig || data.op !== op || !data.publickey || !data.ts) {
            const e = { type: 'error', error: `Formato ${op} inválido` };
            applyMessageIds(e, message); ws.send(JSON.stringify(e)); return null;
        }
        const skew = Math.abs(Date.now() - Number(data.ts));
        if (!Number.isFinite(skew) || skew > IDENTIFY_TS_TOLERANCE_MS) {
            const e = { type: 'error', error: `${op} ts fuera de la ventana ±5min` };
            applyMessageIds(e, message); ws.send(JSON.stringify(e)); return null;
        }
        let jwk;
        try { jwk = JSON.parse(data.publickey); }
        catch (_) {
            const e = { type: 'error', error: `${op}.publickey debe ser JWK serializado` };
            applyMessageIds(e, message); ws.send(JSON.stringify(e)); return null;
        }
        if (!verifySignatureWithJWK(data, sig, jwk)) {
            const e = { type: 'error', error: `Firma ${op} inválida` };
            applyMessageIds(e, message); ws.send(JSON.stringify(e)); return null;
        }
        return data;
    }

    // Credenciales TURN temporales (Cloudflare) para WebRTC. Solo para
    // conexiones YA identificadas con esa misma pubkey: la firma del sobre
    // prueba la identidad, y el bind pubkey↔token evita re-jugar un sobre
    // ajeno desde otro socket. El TTL corto + cuota por pubkey/hora evitan
    // que las credenciales se farmeen para tráfico ajeno al ecosistema.
    //   data: { op:'turn-credentials', publickey, ts }
    async function handleTurnCredentialsMessage(ws, message) {
        try {
            const data = verifySignedOp(ws, message, 'turn-credentials');
            if (!data) return;
            const boundPubkey = tokenToPubkey.get(ws.token);
            if (boundPubkey !== data.publickey) {
                const e = { type: 'error', error: 'turn-credentials requiere identify previo con esa pubkey' };
                applyMessageIds(e, message); ws.send(JSON.stringify(e)); return;
            }
            if (!turnIssuer.enabled) {
                const response = { type: 'turn-credentials', enabled: false };
                applyMessageIds(response, message);
                ws.send(JSON.stringify(response));
                return;
            }
            const result = await turnIssuer.issue(data.publickey);
            if (result.limited) {
                const e = {
                    type: 'error',
                    error: 'turn-credentials: cuota por hora alcanzada',
                    retry_after_ms: result.retry_after_ms
                };
                applyMessageIds(e, message); ws.send(JSON.stringify(e)); return;
            }
            const response = {
                type: 'turn-credentials',
                enabled: true,
                iceServers: result.iceServers,
                expiresAt: result.expiresAt,
                ttl: result.ttl
            };
            applyMessageIds(response, message);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
        } catch (e) {
            console.error('handleTurnCredentialsMessage error:', e.message);
            try {
                const errorResponse = { type: 'error', error: 'turn-credentials: error emitiendo credenciales' };
                applyMessageIds(errorResponse, message);
                ws.send(JSON.stringify(errorResponse));
            } catch (_) {}
        }
    }

    // Programar un push a la PROPIA pubkey. data.spec = JSON string con
    // { fireAt?:ms (one-shot) | cron?:string + tz?:string, payload?:object }.
    function handleSchedulePushMessage(ws, message) {
        try {
            const data = verifySignedOp(ws, message, 'schedule-push');
            if (!data) return;
            let spec;
            try { spec = JSON.parse(data.spec); }
            catch (_) {
                const e = { type: 'error', error: 'schedule-push.spec JSON inválido' };
                applyMessageIds(e, message); ws.send(JSON.stringify(e)); return;
            }
            let nextFire;
            const cron = spec.cron || null;
            const tz = spec.tz || null;
            if (cron) {
                nextFire = cronNextFire(cron, tz, Date.now());
                if (!nextFire) {
                    const e = { type: 'error', error: 'cron inválido' };
                    applyMessageIds(e, message); ws.send(JSON.stringify(e)); return;
                }
            } else {
                nextFire = Number(spec.fireAt);
                if (!Number.isFinite(nextFire) || nextFire <= Date.now()) {
                    const e = { type: 'error', error: 'fireAt debe ser un timestamp futuro (ms)' };
                    applyMessageIds(e, message); ws.send(JSON.stringify(e)); return;
                }
            }
            const payload = spec.payload ? JSON.stringify(spec.payload) : null;
            const jobId = persist.insertScheduledPush({ pubkey: data.publickey, payload, nextFire, cron, tz });
            const response = { type: 'push-scheduled', jobId, nextFire };
            applyMessageIds(response, message);
            ws.send(JSON.stringify(response));
        } catch (e) {
            console.error('handleSchedulePushMessage error:', e);
        }
    }

    // Cancelar un job propio. data.jobId.
    function handleCancelPushMessage(ws, message) {
        try {
            const data = verifySignedOp(ws, message, 'cancel-push');
            if (!data) return;
            const jobId = Number(data.jobId);
            const job = persist.getScheduledPush(jobId);
            // Self-only: solo podés cancelar tus propios jobs.
            if (job && job.pubkey === data.publickey) persist.deleteScheduledPush(jobId);
            const response = { type: 'push-canceled', jobId };
            applyMessageIds(response, message);
            ws.send(JSON.stringify(response));
        } catch (e) {
            console.error('handleCancelPushMessage error:', e);
        }
    }

    // Listar los jobs propios.
    function handleListPushesMessage(ws, message) {
        try {
            const data = verifySignedOp(ws, message, 'list-pushes');
            if (!data) return;
            const rows = persist.listScheduledPushesForPubkey(data.publickey);
            const jobs = rows.map(r => ({
                jobId: r.id,
                nextFire: r.next_fire,
                cron: r.cron || null,
                tz: r.tz || null,
                payload: r.payload ? JSON.parse(r.payload) : null
            }));
            const response = { type: 'push-list', jobs };
            applyMessageIds(response, message);
            ws.send(JSON.stringify(response));
        } catch (e) {
            console.error('handleListPushesMessage error:', e);
        }
    }

    function handlePubkeyAddressedMessage(ws, message, targetPubkeys) {
        const senderPubkey = tokenToPubkey.get(ws.token) || null;
        const now = Date.now();
        const expiresAt = now + OFFLINE_TTL_MS;
        const sentInline = [];
        const queued = [];
        const failed = [];
        let totalDeliveries = 0;
        for (const pk of targetPubkeys) {
            if (!pk || typeof pk !== 'string') { failed.push(pk); continue; }
            // Self?
            if (senderPubkey && pk === senderPubkey) { failed.push(pk); continue; }
            const targetTokens = pubkeyToTokens.get(pk);  // Set or undefined
            // Filtrar tokens cuyo ws siga vivo (no debería haber zombies, pero por si acaso).
            const liveConns = [];
            if (targetTokens) {
                for (const t of targetTokens) {
                    const conn = activeConnections.get(t);
                    if (conn) liveConns.push({ token: t, conn });
                }
            }
            if (liveConns.length > 0) {
                let anySent = false;
                // Fan-out: una entrega por cada instancia activa de la pubkey.
                for (const { token: targetToken, conn } of liveConns) {
                    try {
                        conn.ws.send(JSON.stringify({
                            type: 'message',
                            from: ws.token,
                            from_publickey: senderPubkey,
                            message: message.message
                        }));
                        connectionPairs.add(createPairKey(ws.token, targetToken));
                        anySent = true;
                        totalDeliveries++;
                    } catch (_) { /* skip esa instancia, intenta las demás */ }
                }
                if (anySent) sentInline.push(pk);
                else failed.push(pk);
            } else if (PROXY_PEERS.length) {
                // Federación: no hay instancias locales → reenviar a la malla (un
                // peer puede tener al destinatario online, o ser su home y encolar).
                // ADEMÁS encolamos local como FALLBACK para no perder el mensaje si
                // el home aún no se conoce (la app dedup por `mid`). El receptor
                // federado, en cambio, solo encola si es home (evita acumular en
                // proxies intermedios).
                forwardToPeers(pk, message.message, senderPubkey, now, expiresAt);
                const bytes = bytesOfMessage(message.message);
                enqueueOffline(pk, { from: ws.token, fromPubkey: senderPubkey, message: message.message, queuedAt: now, expiresAt, bytes });
                ringPush(pk);
                queued.push(pk);
            } else {
                // Sin federación: comportamiento actual (cola offline 24h single-drain).
                const bytes = bytesOfMessage(message.message);
                enqueueOffline(pk, {
                    from: ws.token,
                    fromPubkey: senderPubkey,
                    message: message.message,
                    queuedAt: now,
                    expiresAt,
                    bytes
                });
                queued.push(pk);
                // Timbre push (sin contenido): despierta al SW del destinatario
                // para que reconecte y baje su cola. Best-effort.
                ringPush(pk);
            }
        }
        if (queued.length || failed.length) {
            const response = {
                type: 'message_sent',
                sent: sentInline.length,
                deliveries: totalDeliveries,  // entregas reales tras fan-out
                queued: queued,
                failed: failed
            };
            applyMessageIds(response, message);
            try { ws.send(JSON.stringify(response)); } catch (_) {}
        }
    }

    // Manejar cierre de conexión
    ws.on('close', () => {
        if (token && activeConnections.has(token)) {
            // Notificar primero a miembros de canal (mensaje incluye 'channel'),
            // antes de removeFromAllPublicChannels para que aún estén las entradas.
            const notifiedByChannels = notifyChannelMembersOfDisconnect(token);

            // Notificar a pares restantes (deduplicando contra los ya notificados por canal)
            const notifiedByPairs = notifyPairedClients(token, notifiedByChannels);

            // Remover de activeConnections
            activeConnections.delete(token);

            // Soltar binding pubkey<->token (los mensajes que lleguen ahora
            // por to_publickey caerán a la cola offline hasta que el cliente
            // se reconecte e identifique de nuevo).
            unbindPubkeyFromToken(token);

            // Liberar token inmediatamente
            tokenManager.releaseToken(token);

            // Liberar el estado del rate limiter para este token
            rateLimiter.releaseToken(token);

            // Remover de todos los canales públicos inmediatamente
            removeFromAllPublicChannels(token);

            // Remover de los canales que observaba (read-only)
            removeFromAllWatchers(token);

            if (process.env.NODE_ENV !== 'test') console.log(`Cliente desconectado - Token: ${token}. Notificados: ${notifiedByChannels.size} por canal + ${notifiedByPairs} por par. Total activos: ${activeConnections.size}`);
        }
    });
    
    // Manejar errores en la conexión
    ws.on('error', (error) => {
        console.error(`Error en WebSocket para token ${token}:`, error);
    });
});

// Handles de intervalos para poder limpiarlos en stop()
let channelCleanupInterval = null;
let tokenCleanupInterval = null;
let offlineQueueInterval = null;
let scheduledPushInterval = null;

/**
 * Inicia el servidor en el puerto indicado.
 * @param {number} [port] Puerto a usar. 0 = puerto asignado por el OS. Default: PORT del entorno.
 * @returns {Promise<number>} Puerto efectivo en el que está escuchando.
 */
function start(port = Number(PORT)) {
    return new Promise((resolve, reject) => {
        channelCleanupInterval = setInterval(cleanupExpiredChannelEntries, 60 * 1000);
        tokenCleanupInterval = tokenManager.startCleanupInterval(5);
        offlineQueueInterval = setInterval(cleanupOfflineQueues, 60 * 1000);
        // Push programado: descartar lo vencido al arrancar y luego tick periódico.
        reconcileScheduledPushes();
        scheduledPushInterval = setInterval(runScheduledPushes, SCHED_TICK_MS);
        // Federación: purgar registros de "home" vencidos (TTL) cada hora.
        setInterval(() => {
            try {
                const cutoff = Date.now() - HOME_TTL_MS;
                persist.deleteExpiredHomes(cutoff);
                homePubkeys.clear();
                for (const pk of persist.loadHomes(cutoff)) homePubkeys.add(pk);
            } catch (e) { console.warn('[fed] purga de homes falló:', e.message); }
        }, 60 * 60 * 1000).unref();
        if (PROXY_PEERS.length) {
            console.log(`[fed] federación activa con ${PROXY_PEERS.length} peer(s): ${PROXY_PEERS.join(', ')}`);
            if (!nodeIdentity) {
                // Sin identidad no se puede firmar ni verificar: la federación queda
                // inerte en vez de caer al secreto compartido de antes. Se dice fuerte
                // porque el síntoma (nada cruza) es idéntico a no tener peers.
                console.error('[fed] ESTE NODO NO TIENE IDENTIDAD (falta vault-service/service-identity.json):');
                console.error('[fed] no puede firmar ni aceptar tramas s2s. Enrola el nodo: node enroll-vault.js …');
            } else {
                console.log(`[fed] identidad de nodo lista — prefijo ${nodeIdentity.prefix}`);
                const restored = peerRegistry.load();
                if (restored) console.log(`[fed] ${restored} peer(s) pineados restaurados de disco`);
                peerRegistry.discoverAll().catch((e) => console.warn('[fed] descubrimiento inicial falló:', e.message));
                peerRegistry.startRefresh();
                mesh.start();
            }
        }

        const onError = (err) => {
            server.removeListener('error', onError);
            reject(err);
        };
        server.on('error', onError);

        // HOST opcional: bindear a 127.0.0.1 detrás de nginx (no exponer el puerto
        // crudo). Sin HOST → todas las interfaces (comportamiento previo).
        const bindHost = process.env.HOST || undefined;
        server.listen(port, bindHost, () => {
            server.removeListener('error', onError);
            const actualPort = server.address().port;
            if (process.env.NODE_ENV !== 'test') {
                console.log(`=========================================`);
                console.log(`🚀 Servidor WebSocket proxy simplificado iniciado`);
                console.log(`📡 Puerto: ${actualPort}`);
                console.log(`🌐 URL: ws://localhost:${actualPort}/`);
                console.log(`📊 Total conexiones activas: 0`);
                console.log(`=========================================`);
                console.log(`⏰ ${new Date().toLocaleString()}`);
                console.log(`=========================================`);
                // Secretos del vault (TURN): DESPUÉS de escuchar — el transporte
                // nunca espera al vault; solo la feature. En tests no aplica.
                try { startVaultSecretsLoop(); } catch (e) { console.error('[vault] no se pudo iniciar la carga de secretos:', e.message); }
            }
            resolve(actualPort);
        });
    });
}

/**
 * Detiene el servidor: limpia intervalos, cierra todas las conexiones y resetea el estado.
 * @returns {Promise<void>}
 */
function stop() {
    if (channelCleanupInterval) {
        clearInterval(channelCleanupInterval);
        channelCleanupInterval = null;
    }
    if (offlineQueueInterval) {
        clearInterval(offlineQueueInterval);
        offlineQueueInterval = null;
    }
    if (scheduledPushInterval) {
        clearInterval(scheduledPushInterval);
        scheduledPushInterval = null;
    }
    if (tokenCleanupInterval) {
        clearInterval(tokenCleanupInterval);
        tokenCleanupInterval = null;
    }
    peerRegistry.stopRefresh();
    mesh.stop();

    // Cerrar todas las conexiones de cliente
    for (const [, conn] of activeConnections) {
        try { conn.ws.terminate(); } catch (_) { /* noop */ }
    }
    activeConnections.clear();
    publicChannels.clear();
    connectionPairs.clear();

    // Resetear tokenManager
    for (const t of tokenManager.getAllActiveTokens()) {
        tokenManager.releaseToken(t);
    }

    // Reset rate limiter (drops in-memory state, allows tests to start fresh)
    if (rateLimiter && typeof rateLimiter.destroy === 'function') {
        rateLimiter.destroy();
    }
    rateLimiter = createRateLimiter();

    // Reset del emisor TURN (limpia cache/cuotas; releé el .env)
    if (turnIssuer && typeof turnIssuer.destroy === 'function') turnIssuer.destroy();
    turnIssuer = createTurnIssuer();
    if (vaultSecretsHandle && typeof vaultSecretsHandle.stop === 'function') vaultSecretsHandle.stop();
    vaultSecretsHandle = null;

    return new Promise((resolve) => {
        wss.close(() => {
            server.close(() => resolve());
        });
    });
}

// Auto-start solo cuando se ejecuta directamente (no cuando se importa desde tests)
if (require.main === module) {
    start().catch((err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`Error: El puerto ${Number(PORT)} ya está en uso.`);
            console.error(`   Puedes cambiar el puerto en el archivo .env o liberar el puerto.`);
        } else {
            console.error(`Error al iniciar servidor:`, err);
        }
        process.exit(1);
    });
}

/**
 * Reemplazar el rate limiter activo (utilidad para tests con configuración custom).
 */
function setRateLimiter(newLimiter) {
    if (rateLimiter && typeof rateLimiter.destroy === 'function') rateLimiter.destroy();
    rateLimiter = newLimiter;
}

function getRateLimiter() { return rateLimiter; }

/** Reemplazar el emisor TURN activo (utilidad para tests con fetch mockeado). */
function setTurnIssuer(newIssuer) {
    if (turnIssuer && typeof turnIssuer.destroy === 'function') turnIssuer.destroy();
    turnIssuer = newIssuer;
}

module.exports = { start, stop, server, wss, setRateLimiter, getRateLimiter, setTurnIssuer };

// Manejo de cierre limpio. Atendemos SIGINT (Ctrl+C) y SIGTERM: este último es
// el que manda `systemctl stop/restart`; sin handler, Node lo terminaba pero el
// servicio quedaba a la espera del TimeoutStopSec (~30-90s) — los deploys del CD
// (cc-deploy) reiniciaban lentísimo. Con SIGTERM atendido, el restart es inmediato.
let shuttingDown = false;
function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n=========================================');
    console.log(`Recibida señal ${signal}`);
    console.log(`Cerrando ${activeConnections.size} conexiones activas...`);

    // Avisar la baja a los peers ANTES de cerrar. Esto era imposible: la función
    // cerraba los sockets y llamaba a process.exit(0) en la línea siguiente, de
    // forma síncrona, así que nada asíncrono llegaba a salir. Como consecuencia,
    // en CADA deploy los peers seguían ruteando hacia un proceso muerto hasta
    // que se les caía el enlace por su cuenta.
    try { mesh.sayGoodbye(); } catch (_) {}

    // Cerrar todas las conexiones activas
    for (const [token, conn] of activeConnections) {
        conn.ws.close();
    }

    // Margen corto para que salgan los `bye` y los `close` por el cable. No es
    // "esperar a que todo termine": es no matar el proceso en el mismo tick.
    const grace = setTimeout(() => {
        try { mesh.stop(); } catch (_) {}
        console.log('Servidor cerrado correctamente');
        console.log('=========================================');
        process.exit(0);
    }, Number(process.env.PROXY_SHUTDOWN_GRACE_MS || 250));
    if (grace.unref) grace.unref();
}
process.on('SIGINT', () => gracefulShutdown('SIGINT (Ctrl+C)'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
