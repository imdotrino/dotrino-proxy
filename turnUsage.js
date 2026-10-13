/**
 * TOPE GLOBAL DE TRÁFICO DEL TURN, por día.
 *
 * Las cuotas de `turnCredentials.js` acotan cuántas credenciales se emiten, no cuánto
 * tráfico pasa por ellas: una sola credencial releva lo que quiera durante su vigencia, y
 * el relevo lo paga la cuenta de Cloudflare. Cloudflare no deja poner un tope de bytes al
 * generar la credencial, así que el tope se hace aquí: se le pregunta cuánto salió hoy
 * (su API de analíticas) y, al pasarse, el proxy deja de emitir hasta el día siguiente.
 *
 * Qué acota y qué no: acota el GASTO. No decide quién usa el relevo —eso es otra puerta—,
 * y al llegar al tope se quedan sin relevo todos, también los legítimos, que siguen por el
 * proxy (el escalón que siempre funciona).
 *
 * Cuánto se puede pasar del tope: lo que tarde el siguiente sondeo, más lo que tarde
 * Cloudflare en contarlo, más la vigencia de las credenciales ya emitidas.
 *
 * SIN LECTURA NO HAY EMISIÓN. Si el tope está puesto y no se sabe cuánto va —la primera
 * lectura aún no llegó, o la última buena es vieja—, no se emite. Lo contrario sería que el
 * tope se quitara solo justo cuando la API falla, que es cuando menos se sabe.
 *
 * Config (todo `TURN_*`, así que se vuelve a aplicar cuando la bóveda avisa de un cambio):
 *   TURN_ACCOUNT_ID            id de la cuenta de Cloudflare
 *   TURN_ANALYTICS_API_TOKEN   token con permiso «Account Analytics» (solo lectura)
 *   TURN_DAILY_EGRESS_GB       tope diario, en GB salientes (default 20)
 *   TURN_USAGE_POLL_SECONDS    cada cuánto se pregunta (default 300, mínimo 60)
 *   TURN_USAGE_API             override del endpoint (tests)
 *
 * Sin `TURN_ACCOUNT_ID` o sin `TURN_ANALYTICS_API_TOKEN` el tope queda APAGADO, y se dice
 * en el log al arrancar.
 */

const DEFAULT_DAILY_GB = 20;
const DEFAULT_POLL_S = 300;
const DEFAULT_API = 'https://api.cloudflare.com/client/v4/graphql';
const DEFAULT_FETCH_TIMEOUT_MS = 10000;
const GB = 1e9; // Cloudflare cobra por GB decimal
const DAY_MS = 24 * 60 * 60 * 1000;

const QUERY = `query ($account: String!, $from: Date!, $to: Date!, $key: String!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      callsTurnUsageAdaptiveGroups(limit: 1, filter: { date_geq: $from, date_leq: $to, keyId: $key }) {
        sum { egressBytes ingressBytes }
      }
    }
  }
}`;

const utcDay = (now) => new Date(now).toISOString().slice(0, 10);
const msToNextUtcDay = (now) => Math.max(1000, DAY_MS - (now % DAY_MS));

function createTurnUsage(opts = {}) {
    const accountId = opts.accountId ?? process.env.TURN_ACCOUNT_ID ?? '';
    const apiToken = opts.apiToken ?? process.env.TURN_ANALYTICS_API_TOKEN ?? '';
    const keyId = opts.keyId ?? process.env.TURN_KEY_ID ?? '';
    const dailyGb = Number(opts.dailyGb ?? process.env.TURN_DAILY_EGRESS_GB) || DEFAULT_DAILY_GB;
    const pollMs = Math.max(60, Number(opts.pollSeconds ?? process.env.TURN_USAGE_POLL_SECONDS) || DEFAULT_POLL_S) * 1000;
    // Una lectura vale mientras no falten tres sondeos seguidos.
    const staleMs = Number(opts.staleMs) || pollMs * 3 + 60 * 1000;
    const fetchTimeoutMs = Number(opts.fetchTimeoutMs) || DEFAULT_FETCH_TIMEOUT_MS;
    const api = opts.api ?? process.env.TURN_USAGE_API ?? DEFAULT_API;
    const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    const onAlert = typeof opts.onAlert === 'function' ? opts.onAlert : () => {};
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

    const enabled = Boolean(accountId && apiToken && keyId && fetchImpl);
    const capBytes = Math.floor(dailyGb * GB);

    // La última lectura buena: { day, egressBytes, at }.
    let last = null;
    let lastError = null;
    let timer = null;
    // La lectura en curso, para que quien pregunta mientras tanto la espere en vez de rebotar.
    let pending = null;
    // Lo ya avisado, para que cada cosa suene UNA vez: el día del tope y el episodio sin lectura.
    let alertedCapDay = null;
    let alertedUnknown = false;

    async function read() {
        const day = utcDay(now());
        const ac = typeof AbortController === 'function' ? new AbortController() : null;
        const t = ac ? setTimeout(() => ac.abort(), fetchTimeoutMs) : null;
        let res;
        try {
            res = await fetchImpl(api, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: QUERY, variables: { account: accountId, from: day, to: day, key: keyId } }),
                ...(ac ? { signal: ac.signal } : {})
            });
        } finally {
            if (t) clearTimeout(t);
        }
        if (!res.ok) throw new Error(`Cloudflare analytics API ${res.status}`);
        const body = await res.json();
        if (Array.isArray(body.errors) && body.errors.length) {
            throw new Error(`Cloudflare analytics API: ${String(body.errors[0].message || 'error').slice(0, 200)}`);
        }
        const accounts = body && body.data && body.data.viewer && body.data.viewer.accounts;
        // Una cuenta que el token no ve llega como lista vacía: eso no es «cero tráfico».
        if (!Array.isArray(accounts) || !accounts.length) throw new Error('Cloudflare analytics API: account not visible to this token');
        const groups = accounts[0].callsTurnUsageAdaptiveGroups;
        if (!Array.isArray(groups)) throw new Error('Cloudflare analytics API: no TURN usage dataset in the reply');
        // Sin filas SÍ es cero: hoy no hubo tráfico por esa llave.
        const egressBytes = groups.length ? Number(groups[0].sum && groups[0].sum.egressBytes) : 0;
        if (!Number.isFinite(egressBytes) || egressBytes < 0) throw new Error('Cloudflare analytics API: egressBytes is not a number');
        return { day, egressBytes };
    }

    function refresh() {
        if (!enabled) return Promise.resolve(null);
        if (!pending) pending = doRefresh().finally(() => { pending = null; });
        return pending;
    }

    async function doRefresh() {
        try {
            const r = await read();
            last = { ...r, at: now() };
            lastError = null;
            alertedUnknown = false;
            if (r.egressBytes >= capBytes && alertedCapDay !== r.day) {
                alertedCapDay = r.day;
                onAlert({ kind: 'turn-daily-cap', day: r.day, egressBytes: r.egressBytes, capBytes });
            }
        } catch (e) {
            lastError = e.message;
            if (!fresh() && !alertedUnknown) {
                alertedUnknown = true;
                onAlert({ kind: 'turn-usage-unknown', error: e.message, capBytes });
            }
        }
        return last;
    }

    // ¿Hay una lectura de HOY y reciente?
    function fresh() {
        const t = now();
        return Boolean(last && last.day === utcDay(t) && t - last.at <= staleMs);
    }

    /**
     * ¿Se puede emitir ahora?
     * @returns {{ok:true}|{ok:false, reason:'turn-daily-cap'|'turn-usage-unknown', retry_after_ms:number}}
     */
    function allowed() {
        if (!enabled) return { ok: true };
        if (!fresh()) return { ok: false, reason: 'turn-usage-unknown', retry_after_ms: Math.min(pollMs, 60 * 1000) };
        if (last.egressBytes >= capBytes) return { ok: false, reason: 'turn-daily-cap', retry_after_ms: msToNextUtcDay(now()) };
        return { ok: true };
    }

    /**
     * Espera a la lectura en curso si todavía no hay una buena. Al arrancar (o al reiniciar)
     * todos los clientes se identifican en los primeros segundos y piden credenciales UNA
     * vez: rebotarlos por una lectura que llega en medio segundo los dejaría sin relevo
     * hasta su siguiente reconexión.
     */
    async function settle() {
        if (enabled && !fresh() && pending) await pending;
    }

    function start() {
        if (!enabled || timer) return;
        refresh();
        timer = setInterval(() => { refresh(); }, pollMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
    }

    function destroy() {
        if (timer) { clearInterval(timer); timer = null; }
        last = null;
    }

    function state() {
        return { enabled, capBytes, day: last ? last.day : null, egressBytes: last ? last.egressBytes : null, readAt: last ? last.at : null, fresh: fresh(), lastError };
    }

    return { enabled, capBytes, allowed, settle, refresh, start, destroy, state };
}

module.exports = { createTurnUsage };
