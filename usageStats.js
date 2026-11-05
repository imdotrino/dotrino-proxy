/**
 * Estadísticas de uso del proxy.
 *
 * Reemplaza al baneo de IPs: en lugar de cortar a un cliente cuando supera
 * el hard rate limit, contamos los eventos por IP/tipo y persistimos un
 * snapshot a un archivo JSON. Útil para detectar abuso real sin afectar
 * usuarios reales con falsos positivos.
 *
 * Variables de entorno:
 *   USAGE_STATS_FILE      ruta del archivo JSON (default: usage-stats.json en cwd)
 *   USAGE_STATS_INTERVAL  ms entre flushes (default 60_000)
 *   USAGE_STATS_RETENTION_DAYS  cuánto se guarda una IP sin volver a verse (default 30)
 *
 * RETENCIÓN, porque esto guarda DIRECCIONES IP. Contarlas para frenar el abuso es
 * legítimo; guardarlas para siempre no lo es, y hasta el 2026-09-02 no se borraba
 * ninguna: `perIp` solo crecía. Una IP que no vuelve a aparecer en 30 días se va, y el
 * plazo se puede cambiar. Lo que queda entonces es lo agregado, que no señala a nadie.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PATH = path.resolve(process.cwd(), 'usage-stats.json');
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_RETENTION_DAYS = 30;

/**
 * Contadores de una IP.
 * @typedef {{ messages: number, hardLimits: number, softLimits: number, firstSeen: number, lastSeen: number }} IpStats
 */

/**
 * @param {{ filePath?: string, intervalMs?: number | string, retentionDays?: number | string }} [options]
 */
function createUsageStats(options = {}) {
  const filePath = options.filePath
    || process.env.USAGE_STATS_FILE
    || DEFAULT_PATH;
  // String(): parseInt ya convierte su argumento; aquí solo se hace visible.
  const intervalMs = Number.parseInt(String(
    options.intervalMs != null ? options.intervalMs
      : process.env.USAGE_STATS_INTERVAL != null ? process.env.USAGE_STATS_INTERVAL
      : DEFAULT_INTERVAL_MS), 10
  );
  const retentionDays = Number.parseInt(String(
    options.retentionDays != null ? options.retentionDays
      : process.env.USAGE_STATS_RETENTION_DAYS != null ? process.env.USAGE_STATS_RETENTION_DAYS
      : DEFAULT_RETENTION_DAYS), 10
  );

  const startedAt = Date.now();
  /**
   * @type {{ startedAt: number, lastFlushAt: number, perIp: Record<string, IpStats>, perOp: Record<string, number>,
   *   totalConnections: number, totalMessages: number, totalHardLimits: number, totalSoftLimits: number, retentionDays?: number }}
   */
  const data = {
    startedAt,
    lastFlushAt: 0,
    perIp: {},          // ip -> { messages, hardLimits, softLimits, lastSeen }
    perOp: {},          // op  -> count
    totalConnections: 0,
    totalMessages: 0,
    totalHardLimits: 0,
    totalSoftLimits: 0
  };

  // Carga snapshot previo si existe (continua acumulando entre reinicios).
  try {
    if (fs.existsSync(filePath)) {
      const prev = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      Object.assign(data, prev, { startedAt });  // mantiene contadores, refresca startedAt
    }
  } catch (e) {
    console.warn('[usage-stats] could not load previous file:', /** @type {Error} */ (e).message);
  }

  /**
   * @param {string | null | undefined} ip
   * @returns {IpStats | null}
   */
  function ensureIp(ip) {
    if (!ip) return null;
    let s = data.perIp[ip];
    if (!s) {
      s = { messages: 0, hardLimits: 0, softLimits: 0, firstSeen: Date.now(), lastSeen: 0 };
      data.perIp[ip] = s;
    }
    return s;
  }

  /** @param {string | null | undefined} ip */
  function recordConnection(ip) {
    data.totalConnections += 1;
    const s = ensureIp(ip);
    if (s) s.lastSeen = Date.now();
  }

  /** @param {string | null | undefined} ip @param {string | null} [op] */
  function recordMessage(ip, op) {
    data.totalMessages += 1;
    const s = ensureIp(ip);
    if (s) { s.messages += 1; s.lastSeen = Date.now(); }
    if (op) data.perOp[op] = (data.perOp[op] || 0) + 1;
  }

  /** @param {string | null | undefined} ip @param {string | null} [op] */
  function recordHardLimit(ip, op) {
    data.totalHardLimits += 1;
    const s = ensureIp(ip);
    if (s) { s.hardLimits += 1; s.lastSeen = Date.now(); }
    if (op) {
      const k = `hard:${op}`;
      data.perOp[k] = (data.perOp[k] || 0) + 1;
    }
    flushSoon();  // hard limits son raros y vale la pena flush rápido
  }

  /** @param {string | null | undefined} ip @param {string | null} [op] */
  function recordSoftLimit(ip, op) {
    data.totalSoftLimits += 1;
    const s = ensureIp(ip);
    if (s) { s.softLimits += 1; s.lastSeen = Date.now(); }
    if (op) {
      const k = `soft:${op}`;
      data.perOp[k] = (data.perOp[k] || 0) + 1;
    }
  }

  let flushPending = false;
  function flushSoon() {
    if (flushPending) return;
    flushPending = true;
    setTimeout(() => { flushPending = false; flush(); }, 1000);
  }

  /**
   * Se olvida a quien no ha vuelto. Va en el `flush` y no en un temporizador aparte
   * porque así se aplica siempre que se escribe: no hay forma de que el archivo del
   * disco tenga algo más viejo que el plazo.
   * @param {number} now
   * @returns {number} cuántas IPs se olvidaron
   */
  function forgetOld(now) {
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    let forgotten = 0;
    for (const [ip, s] of Object.entries(data.perIp)) {
      if ((s.lastSeen || s.firstSeen || 0) < cutoff) { delete data.perIp[ip]; forgotten += 1; }
    }
    return forgotten;
  }

  function flush() {
    data.lastFlushAt = Date.now();
    data.retentionDays = retentionDays;
    forgetOld(data.lastFlushAt);
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn('[usage-stats] flush failed:', /** @type {Error} */ (e).message);
    }
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(data));
  }

  const interval = setInterval(flush, intervalMs);
  if (interval.unref) interval.unref();

  // Best-effort flush on exit signals.
  process.on('exit', () => { try { flush(); } catch (_) {} });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { try { flush(); } catch (_) {} });
  }

  function destroy() {
    clearInterval(interval);
    flush();
  }

  return {
    forgetOld,
    recordConnection,
    recordMessage,
    recordHardLimit,
    recordSoftLimit,
    flush,
    snapshot,
    destroy,
    filePath
  };
}

module.exports = { createUsageStats };
