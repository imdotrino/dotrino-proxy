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

function makeBucket(burst, ratePerSec) {
  return { tokens: burst, lastRefill: Date.now(), burst, ratePerSec };
}

function refill(bucket, now) {
  if (now <= bucket.lastRefill) return;
  const elapsedSec = (now - bucket.lastRefill) / 1000;
  const refilled = elapsedSec * bucket.ratePerSec;
  bucket.tokens = Math.min(bucket.burst, bucket.tokens + refilled);
  bucket.lastRefill = now;
}

function tryConsume(bucket, now) {
  refill(bucket, now);
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { ok: true };
  }
  const missing = 1 - bucket.tokens;
  const retry_after_ms = Math.ceil((missing / bucket.ratePerSec) * 1000);
  return { ok: false, retry_after_ms };
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

  const tokens = new Map();
  const ipBans = new Map();

  function getOrCreate(token) {
    let entry = tokens.get(token);
    if (!entry) {
      entry = {
        soft: {
          global: makeBucket(softLimits.__global__.burst, softLimits.__global__.ratePerSec),
          types: new Map()
        },
        hard: {
          global: makeBucket(hardLimits.__global__.burst, hardLimits.__global__.ratePerSec),
          types: new Map()
        }
      };
      tokens.set(token, entry);
    }
    return entry;
  }

  function getTypeBucket(entry, tier, type) {
    const tierLimits = (tier === 'hard') ? hardLimits : softLimits;
    const limits = tierLimits[type] || tierLimits.message;
    const map = entry[tier].types;
    let bucket = map.get(type);
    if (!bucket) {
      bucket = makeBucket(limits.burst, limits.ratePerSec);
      map.set(type, bucket);
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

    const entry = getOrCreate(token);

    const hardGlobal = tryConsume(entry.hard.global, now);
    const hardType   = tryConsume(getTypeBucket(entry, 'hard', type), now);
    if (!hardGlobal.ok || !hardType.ok) {
      const which = !hardGlobal.ok ? 'global' : 'per_type';
      const retry = Math.max(hardGlobal.retry_after_ms || 0, hardType.retry_after_ms || 0);
      return { status: 'hard_limit', retry_after_ms: retry, limit_type: which };
    }

    const softGlobal = tryConsume(entry.soft.global, now);
    const softType   = tryConsume(getTypeBucket(entry, 'soft', type), now);
    if (!softGlobal.ok || !softType.ok) {
      const which = !softGlobal.ok ? 'global' : 'per_type';
      const retry = Math.max(softGlobal.retry_after_ms || 0, softType.retry_after_ms || 0);
      return { status: 'soft_limit', retry_after_ms: retry, limit_type: which };
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
