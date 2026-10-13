/**
 * AVISOS AL QUE OPERA EL PROXY, por correo (Resend).
 *
 * Para lo que no puede quedarse en un log que nadie mira: el TURN llegó a su tope diario,
 * o el proxy no consigue leer cuánto lleva. Un tope que corta en silencio se descubre días
 * después, por el lado de «esto va lento».
 *
 * El aviso sale SIEMPRE por el log (`[alert]`, para poder buscarlo), y además por correo si
 * está configurado. Las variables se leen en cada envío, así que valen en cuanto la bóveda
 * las entrega, sin reiniciar:
 *   ALERT_RESEND_API_KEY   llave de Resend
 *   ALERT_EMAIL_TO         a quién
 *   ALERT_EMAIL_FROM       remitente, de un dominio verificado en Resend
 *
 * Si falta alguna, o el envío falla, se dice en el log: un aviso que no se pudo mandar
 * tampoco se calla.
 */

const RESEND_API = 'https://api.resend.com/emails';

function alertsConfigured(env = process.env) {
    return Boolean(env.ALERT_RESEND_API_KEY && env.ALERT_EMAIL_TO && env.ALERT_EMAIL_FROM);
}

/**
 * @param {{ subject: string, text: string }} alert
 * @param {{ fetchImpl?: Function, env?: object, log?: Function }} [opts]
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
async function sendAlert({ subject, text }, opts = {}) {
    const env = opts.env || process.env;
    const log = opts.log || console.error;
    const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    log(`[alert] ${subject} — ${text}`);
    if (!alertsConfigured(env) || !fetchImpl) {
        log('[alert] NOT sent by email: ALERT_RESEND_API_KEY, ALERT_EMAIL_TO and ALERT_EMAIL_FROM are not all set');
        return { sent: false, reason: 'not-configured' };
    }
    try {
        const res = await fetchImpl(RESEND_API, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${env.ALERT_RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: env.ALERT_EMAIL_FROM, to: [env.ALERT_EMAIL_TO], subject, text })
        });
        if (!res.ok) {
            log(`[alert] NOT sent by email: Resend answered ${res.status}`);
            return { sent: false, reason: `resend-${res.status}` };
        }
        return { sent: true };
    } catch (e) {
        log(`[alert] NOT sent by email: ${e.message}`);
        return { sent: false, reason: 'network' };
    }
}

const gb = (bytes) => (bytes / 1e9).toFixed(2);

/** El texto de los dos avisos del tope del TURN (`turnUsage.js`). */
function turnAlertText(ev, node = process.env.PROXY_PUBLIC_URL || 'proxy') {
    if (ev.kind === 'turn-daily-cap') {
        return {
            subject: `Dotrino proxy: TURN daily cap reached (${gb(ev.egressBytes)} GB)`,
            text: `${node}: the TURN relay used ${gb(ev.egressBytes)} GB today (${ev.day}, UTC) and the cap is ${gb(ev.capBytes)} GB. ` +
                'No more TURN credentials are issued until the next UTC day; connections that cannot go direct use the proxy. ' +
                'To change the cap: TURN_DAILY_EGRESS_GB in the proxy drawer of the vault.'
        };
    }
    return {
        subject: 'Dotrino proxy: TURN usage cannot be read, TURN is off',
        text: `${node}: the Cloudflare analytics API did not answer (${ev.error}). With a daily cap of ${gb(ev.capBytes)} GB set and no usage reading, ` +
            'no TURN credentials are issued; connections that cannot go direct use the proxy. It resumes by itself with the next good reading. ' +
            'Check TURN_ACCOUNT_ID and TURN_ANALYTICS_API_TOKEN (permission: Account Analytics).'
    };
}

module.exports = { sendAlert, alertsConfigured, turnAlertText };
