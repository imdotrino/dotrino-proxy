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

function createUsageStats(options = {}) {
  const filePath = options.filePath
    || process.env.USAGE_STATS_FILE
    || DEFAULT_PATH;
  const intervalMs = Number.parseInt(
    options.intervalMs != null ? options.intervalMs
      : process.env.USAGE_STATS_INTERVAL != null ? process.env.USAGE_STATS_INTERVAL
      : DEFAULT_INTERVAL_MS, 10
  );
  const retentionDays = Number.parseInt(
    options.retentionDays != null ? options.retentionDays
      : process.env.USAGE_STATS_RETENTION_DAYS != null ? process.env.USAGE_STATS_RETENTION_DAYS
      : DEFAULT_RETENTION_DAYS, 10
  );

  const startedAt = Date.now();
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
    console.warn('[usage-stats] could not load previous file:', e.message);
  }

  function ensureIp(ip) {
    if (!ip) return null;
    let s = data.perIp[ip];
    if (!s) {
      s = { messages: 0, hardLimits: 0, softLimits: 0, firstSeen: Date.now(), lastSeen: 0 };
      data.perIp[ip] = s;
    }
    return s;
  }

  function recordConnection(ip) {
    data.totalConnections += 1;
    const s = ensureIp(ip);
    if (s) s.lastSeen = Date.now();
  }

  function recordMessage(ip, op) {
    data.totalMessages += 1;
    const s = ensureIp(ip);
    if (s) { s.messages += 1; s.lastSeen = Date.now(); }
    if (op) data.perOp[op] = (data.perOp[op] || 0) + 1;
  }

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
      console.warn('[usage-stats] flush failed:', e.message);
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
