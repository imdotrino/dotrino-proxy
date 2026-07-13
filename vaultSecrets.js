/**
 * Secretos del proxy desde el VAULT del ecosistema (en vez del `.env`).
 *
 * El proxy es un SERVICIO CRÍTICO SIN secretos en su core: el transporte
 * (mensajería/canales/identify) arranca siempre, con o sin vault — si no,
 * ni el vault podría hablar. Lo que SÍ depende de secretos (hoy: TURN de
 * Cloudflare) queda apagado hasta que el vault los entregue; el cliente
 * reintenta para siempre (regla del ecosistema: sin vault, la feature espera).
 *
 * Enrolamiento (una vez, ver README):
 *   en el vault:   dotrino-vault pair --service proxy
 *                  dotrino-vault secret set proxy TURN_KEY_ID …
 *   en este host:  node enroll-vault.js '<payload del QR>'
 *
 * Guarda `service-identity.json` en VAULT_SERVICE_DIR (default ./vault-service):
 * llave del servicio + cert con scope SOLO `vault:secrets:proxy`.
 */
const fs = require('fs');
const path = require('path');

const NS = 'proxy';

function serviceDir() {
    return process.env.VAULT_SERVICE_DIR || path.join(__dirname, 'vault-service');
}

function isEnrolled(dir = serviceDir()) {
    return fs.existsSync(path.join(dir, 'service-identity.json'));
}

/**
 * Si el proxy está enrolado al vault, arranca el bucle que espera los secretos
 * (reintentos con backoff, para siempre) y llama a `onSecrets(secrets)` cuando
 * lleguen. Si no está enrolado, no hace nada (self-hosters: .env directo).
 */
function startVaultSecrets({ dir = serviceDir(), onSecrets, log = console.log } = {}) {
    if (!isEnrolled(dir)) return { enabled: false };
    let stopped = false;
    (async () => {
        const { waitForSecrets } = await import('@dotrino/vault/service');
        const secrets = await waitForSecrets({
            dir, ns: NS,
            onRetry: (e, delay) => log(`[vault] sin secretos todavía (${e.message}); reintento en ${Math.round(delay / 1000)}s`)
        });
        if (!stopped) onSecrets(secrets);
    })().catch((e) => log('[vault] carga de secretos abortada:', e.message));
    return { enabled: true, stop: () => { stopped = true; } };
}

module.exports = { startVaultSecrets, isEnrolled, serviceDir, NS };
