/**
 * Two-tier per-token / per-message-type rate limiter for the proxy.
 *
 * Soft tier: when exceeded, the message is still processed but an abuse_notice
 * is emitted upstream so the host app can record a negative event against the
 * sender.
 *
 * Hard tier (default 2x soft): when exceeded, the message is rejected, the
 * connection should be closed by the caller, and the sender's IP is banned for
 * a configurable period (default 30 min).
 */

// Límites "muy generosos": un humano (o una app sana) nunca los toca; solo un
// flood deliberado (DOS) los cruza. El hard tier (2x) es el que rechaza el
// mensaje. Los bans/cierre de conexión siguen deshabilitados por defecto
// (RATE_LIMIT_BAN_DISABLED): el hard-limit solo descarta ESE mensaje y cuenta
// el evento en usageStats; la conexión se mantiene viva. Override por env
// RATE_LIMIT_<TYPE>_BURST / _RATE.
const DEFAULT_LIMITS = {
  // Per-type token buckets: { burst, ratePerSec }
  message:        { burst: 120, ratePerSec: 60 },
  publish:        { burst: 30,  ratePerSec: 10 },
  unpublish:      { burst: 30,  ratePerSec: 10 },
  list:           { burst: 60,  ratePerSec: 15 },
  list_channels:  { burst: 30,  ratePerSec: 8 },
  channel_count:  { burst: 200, ratePerSec: 50 },
  disconnect:     { burst: 20,  ratePerSec: 5 },
  // Emisión de credenciales TURN: pocas por conexión (además hay cuota
  // por pubkey/hora dentro de turnCredentials.js). Env: RATE_LIMIT_TURN-CREDENTIALS_*
  'turn-credentials': { burst: 10, ratePerSec: 0.5 },
  // Directorio de llaves de cifrado. Anunciar es una vez por conexión; preguntar es
  // frecuente al entrar en una sala (uno por miembro) y luego casi nunca, porque el
  // cliente lo cachea. Env: RATE_LIMIT_ENCPUB_* / RATE_LIMIT_ENC-LOOKUP_*
  encpub:         { burst: 10,  ratePerSec: 1 },
  'enc-lookup':   { burst: 60,  ratePerSec: 10 },
  __global__:     { burst: 300, ratePerSec: 120 }
};

const DEFAULT_HARD_MULTIPLIER = 2;
const DEFAULT_BAN_MS = 30 * 60 * 1000;

function readLimit(envBurst, envRate, fallback) {
  const burst = Number.parseInt(process.env[envBurst] || '', 10);
  const rate  = Number.parseFloat(process.env[envRate] || '');
  return {
    burst:      Number.isFinite(burst) && burst > 0 ? burst : fallback.burst,
    ratePerSec: Number.isFinite(rate)  && rate  > 0 ? rate  : fallback.ratePerSec
  };
}

function buildEffectiveLimits() {
  const merged = {};
  for (const type of Object.keys(DEFAULT_LIMITS)) {
    const fb = DEFAULT_LIMITS[type];
    if (type === '__global__') {
      merged.__global__ = readLimit('RATE_LIMIT_GLOBAL_BURST', 'RATE_LIMIT_GLOBAL_RATE', fb);
    } else {
      const upper = type.toUpperCase();
      merged[type] = readLimit(`RATE_LIMIT_${upper}_BURST`, `RATE_LIMIT_${upper}_RATE`, fb);
    }
  }
  return merged;
}

// UNA cubeta lleva los DOS niveles (aviso `s` y corte `h`) con un solo reloj `t`, y no
// guarda sus límites: son los mismos para todas las conexiones y se leen de la tabla.
// Antes cada conexión cargaba dos árboles de cubetas con su `burst` y su `ratePerSec`
// copiados dentro (~1 KB por bóveda conectada, medido el 2026-10-25).
//
// Compartir el reloj no cambia nada: rellenar es lineal y con tope, así que rellenar el
// nivel de aviso en el momento del corte —sin gastar de él— da lo mismo que rellenarlo
// después de una vez.
function makeBucket(lim, now) {
  return { s: lim.soft.burst, h: lim.hard.burst, t: now };
}

function refill(bucket, lim, now) {
  if (now <= bucket.t) return;
  const elapsedSec = (now - bucket.t) / 1000;
  bucket.s = Math.min(lim.soft.burst, bucket.s + elapsedSec * lim.soft.ratePerSec);
  bucket.h = Math.min(lim.hard.burst, bucket.h + elapsedSec * lim.hard.ratePerSec);
  bucket.t = now;
}

// Gasta una ficha del nivel `tier` ('s' o 'h'). Devuelve 0 si había, o cuántos ms faltan.
function take(bucket, tier, rate) {
  if (bucket[tier] >= 1) {
    bucket[tier] -= 1;
    return 0;
  }
  return Math.ceil(((1 - bucket[tier]) / rate) * 1000);
}

function createRateLimiter(options) {
  options = options || {};
  if (process.env.RATE_LIMIT_DISABLED === '1' || options.disabled) {
    return createNoopLimiter();
  }

  const softLimits = options.limits || buildEffectiveLimits();
  const hardMultiplier = Number.parseFloat(
    options.hardMultiplier != null ? options.hardMultiplier
      : process.env.RATE_LIMIT_HARD_MULTIPLIER != null ? process.env.RATE_LIMIT_HARD_MULTIPLIER
      : DEFAULT_HARD_MULTIPLIER
  );
  const banMs = Number.parseInt(
    options.banMs != null ? options.banMs
      : process.env.RATE_LIMIT_BAN_MS != null ? process.env.RATE_LIMIT_BAN_MS
      : DEFAULT_BAN_MS, 10
  );
  // Bans deshabilitados por defecto: en su lugar contamos eventos en
  // un archivo de stats (USAGE_STATS_FILE) para revisar uso sospechoso
  // sin cortar a usuarios reales.
  const banDisabled = options.banDisabled != null
    ? !!options.banDisabled
    : process.env.RATE_LIMIT_BAN_DISABLED !== '0';

  const hardLimits = {};
  for (const k of Object.keys(softLimits)) {
    hardLimits[k] = {
      burst: Math.max(1, Math.ceil(softLimits[k].burst * hardMultiplier)),
      ratePerSec: softLimits[k].ratePerSec * hardMultiplier
    };
  }

  // Límites de los dos niveles juntos, por tipo: `{ soft, hard }`.
  const pairs = {};
  for (const k of Object.keys(softLimits)) pairs[k] = { soft: softLimits[k], hard: hardLimits[k] };
  const limitsFor = (type) => pairs[type] || pairs.message;

  const tokens = new Map();
  const ipBans = new Map();

  function getOrCreate(token, now) {
    let entry = tokens.get(token);
    if (!entry) {
      entry = { global: makeBucket(pairs.__global__, now), types: new Map() };
      tokens.set(token, entry);
    }
    return entry;
  }

  function getTypeBucket(entry, type, lim, now) {
    let bucket = entry.types.get(type);
    if (!bucket) {
      bucket = makeBucket(lim, now);
      entry.types.set(type, bucket);
    }
    return bucket;
  }

  function consume(token, ip, type) {
    if (!token) return { status: 'ok' };
    const now = Date.now();

    if (!banDisabled && ip && ipBans.has(ip) && ipBans.get(ip) > now) {
      return {
        status: 'hard_limit',
        retry_after_ms: ipBans.get(ip) - now,
        limit_type: 'ip_ban'
      };
    }

    const entry = getOrCreate(token, now);
    const globalLim = pairs.__global__;
    const typeLim = limitsFor(type);
    const global = entry.global;
    const perType = getTypeBucket(entry, type, typeLim, now);
    refill(global, globalLim, now);
    refill(perType, typeLim, now);

    // Las dos del corte se cobran siempre, aunque la primera falle (como antes).
    const hardGlobal = take(global, 'h', globalLim.hard.ratePerSec);
    const hardType   = take(perType, 'h', typeLim.hard.ratePerSec);
    if (hardGlobal || hardType) {
      return { status: 'hard_limit', retry_after_ms: Math.max(hardGlobal, hardType), limit_type: hardGlobal ? 'global' : 'per_type' };
    }

    const softGlobal = take(global, 's', globalLim.soft.ratePerSec);
    const softType   = take(perType, 's', typeLim.soft.ratePerSec);
    if (softGlobal || softType) {
      return { status: 'soft_limit', retry_after_ms: Math.max(softGlobal, softType), limit_type: softGlobal ? 'global' : 'per_type' };
    }

    return { status: 'ok' };
  }

  function releaseToken(token) { tokens.delete(token); }

  function banIp(ip, ms) {
    if (!ip || banDisabled) return;
    ipBans.set(ip, Date.now() + (ms || banMs));
  }

  function isIpBanned(ip) {
    if (!ip) return false;
    const until = ipBans.get(ip);
    if (!until) return false;
    if (until <= Date.now()) {
      ipBans.delete(ip);
      return false;
    }
    return true;
  }

  function banRemainingMs(ip) {
    if (!ip) return 0;
    const until = ipBans.get(ip);
    if (!until) return 0;
    return Math.max(0, until - Date.now());
  }

  function unbanIp(ip) { ipBans.delete(ip); }

  function _stats() {
    return { tokenCount: tokens.size, banCount: ipBans.size, softLimits, hardLimits, banMs };
  }

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, until] of ipBans) {
      if (until <= now) ipBans.delete(ip);
    }
  }, 5 * 60 * 1000);
  if (cleanupInterval.unref) cleanupInterval.unref();

  function destroy() { clearInterval(cleanupInterval); tokens.clear(); ipBans.clear(); }

  return {
    consume,
    releaseToken,
    banIp,
    isIpBanned,
    banRemainingMs,
    unbanIp,
    destroy,
    _stats,
    banMs
  };
}

function createNoopLimiter() {
  return {
    consume: () => ({ status: 'ok' }),
    releaseToken: () => {},
    banIp: () => {},
    isIpBanned: () => false,
    banRemainingMs: () => 0,
    unbanIp: () => {},
    destroy: () => {},
    _stats: () => ({ disabled: true }),
    banMs: 0
  };
}

module.exports = { createRateLimiter, DEFAULT_LIMITS };
