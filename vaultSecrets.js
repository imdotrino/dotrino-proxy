/**
 * Configuración del proxy desde el VAULT del ecosistema.
 *
 * El proxy es un agente más de Dotrino: puede correr sin vault (self-hosters,
 * desarrollo) leyendo su `.env` de siempre, o enrolado a uno, y entonces **el
 * vault manda**. Los valores que entrega PISAN los del `.env` y los del entorno
 * (`applyEnv` de `@dotrino/vault/env`). No lo reemplazan: el `.env` sigue siendo
 * lo que arranca la máquina, pero deja de tener la última palabra.
 *
 * Por qué esa precedencia y no la de dotenv: es lo que hace barata la ROTACIÓN.
 * Se cambia la llave en un solo lugar y ninguna copia rancia olvidada en un VPS
 * puede seguir ganando. Al revés —como estaba— rotar exigía además ir a limpiar
 * cada `.env` a mano, y si te olvidabas de uno el proxy arrancaba con la llave
 * vieja sin decir nada.
 *
 * POR QUÉ ESTO NO ES `import '@dotrino/vault/config'`. Ese camino bloquea el
 * arranque hasta que el vault conteste, y aquí sería un abrazo mortal: el vault
 * habla con sus servicios POR EL PROXY, así que un proxy que espera al vault
 * espera a alguien que necesita que el proxy ya esté escuchando. Por eso el
 * transporte arranca SIEMPRE con lo que haya, y la configuración del vault se
 * aplica cuando llega — tarde, y sin bloquear a nadie.
 *
 * Enrolamiento (una vez, ver README):
 *   en el vault:   dotrino-vault pair --service proxy
 *                  dotrino-vault secret set proxy TURN_KEY_ID …
 *   en este host:  node enroll-vault.js '<invitación>'
 *
 * Guarda `service-identity.json` en VAULT_SERVICE_DIR (default ./vault-service):
 * llave del servicio + cert con scope SOLO `vault:secrets:proxy`. En disco NO
 * queda ningún secreto: los valores viven solo en memoria del proceso.
 */
const fs = require('fs');
const path = require('path');

const NS = 'proxy';

/**
 * Lo ÚNICO que el proxio sabe re-aplicar en caliente. Todo lo demás se lee al
 * construir el servidor, así que si el vault lo entrega después —que es siempre,
 * porque no lo esperamos— queda en `process.env` pero no cambia nada hasta el
 * próximo reinicio, y hay que avisarlo: es la diferencia entre rotar y creer que
 * rotaste.
 *
 * La lista dice qué SÍ se re-aplica, y no qué no, a propósito. Enumerar lo que
 * llega tarde exige acordarse de ampliarla cada vez que aparece una variable
 * nueva, y olvidarse falla en silencio (justo lo que pasó con PROXY_MAX_FANOUT).
 * Así al revés, una variable nueva cae sola en «avisa que hace falta reiniciar»,
 * que es el lado seguro del error.
 */
const SE_REAPLICAN = /^TURN_/;

function serviceDir() {
    return process.env.VAULT_SERVICE_DIR || path.join(__dirname, 'vault-service');
}

function isEnrolled(dir = serviceDir()) {
    return fs.existsSync(path.join(dir, 'service-identity.json'));
}

/**
 * Si el proxy está enrolado al vault, arranca el bucle que espera su
 * configuración (reintentos con backoff, para siempre). Cuando llega, la vuelca
 * en `process.env` PISANDO lo que hubiera y llama a `onSecrets` para que el
 * servidor re-aplique en caliente lo que se puede re-aplicar.
 *
 * Si no está enrolado no hace nada: el proxy corre con su `.env`, que es el modo
 * normal de un self-hoster.
 */
function startVaultSecrets({ dir = serviceDir(), onSecrets, onPendiente, log = console.log } = {}) {
    if (!isEnrolled(dir)) return { enabled: false };
    let stopped = false;
    let watcher = null;
    (async () => {
        const { waitForSecrets } = await import('@dotrino/vault/service');
        const { applyEnv, watchEnv } = await import('@dotrino/vault/env');
        const secrets = await waitForSecrets({
            dir, ns: NS,
            onRetry: (e, delay) => log(`[vault] sin configuración todavía (${e.message}); reintento en ${Math.round(delay / 1000)}s`)
        });
        if (stopped) return;

        const { injected, overridden } = applyEnv(secrets);
        log(`[vault] ${injected.length} valor(es) del vault aplicados al entorno`);
        if (overridden.length) {
            // Que el vault haya tenido que pisar algo significa que el `.env` de
            // esta máquina tiene valores viejos. Ganó el vault (para eso está),
            // pero el operador quiere saber que quedó basura por limpiar.
            log(`[vault] pisaron el .env de esta máquina: ${overridden.join(', ')}`);
        }
        const tarde = injected.filter((k) => !SE_REAPLICAN.test(k));
        if (tarde.length) {
            log(`[vault] ⚠ estas sólo se leen al arrancar, así que NO están activas todavía: ${tarde.join(', ')}`);
            log('[vault] ⚠ reinicia el proxy para que tomen efecto.');
        }
        onSecrets(secrets, { injected, overridden });

        // ESCUCHA de cambios. El proxio es el ÚNICO agente que NO se apaga al
        // recibir el aviso: reiniciarlo corta todas las conexiones del ecosistema
        // —incluida la de la bóveda que mandó el aviso—, así que un fallo aquí no
        // se degrada, se cae todo. Lo anota y lo deja a la vista en `GET /node`;
        // el reinicio lo decide un humano o el despliegue.
        //
        // Con la revocación, en cambio, sí conviene ser tajante en el mensaje: un
        // proxio revocado sigue transportando (es su trabajo y no necesita al
        // vault para eso), pero ya no puede leer configuración ni federarse con
        // identidad válida, y eso hay que gritarlo.
        watcher = await watchEnv({
            // Con el log del proxio y NO `quiet`: si la escucha no se establece
            // (o llega un aviso mal firmado, o se cae la conexión), callarlo deja
            // al operador creyendo que está avisable cuando no lo está.
            ns: NS, dir, log: (m) => log(String(m).replace(/^\[dotrino-env\]\s*/, '[vault] ')),
            onUpdate: ({ motivo, ts }) => {
                if (motivo === 'revocado') {
                    log('[vault] ⚠ la bóveda REVOCÓ a este proxio. Sigue transportando, pero no volverá');
                    log('[vault] ⚠ a leer configuración: re-enrólalo o bájalo.');
                    onPendiente?.({ motivo, ts });
                    return;
                }
                log('[vault] hay configuración NUEVA en la bóveda. No se aplica sola:');
                log('[vault] reiniciar el proxio corta las conexiones de todo el ecosistema,');
                log('[vault] así que el momento lo eliges tú. Reinícialo cuando puedas.');
                onPendiente?.({ motivo, ts });
            }
        }).catch((e) => { log('[vault] sin escucha de cambios (' + e.message + ')'); return null; });
    })().catch((e) => log('[vault] carga de configuración abortada:', e.message));
    return {
        enabled: true,
        stop: () => { stopped = true; try { watcher?.stop() } catch (_) {} }
    };
}

module.exports = { startVaultSecrets, isEnrolled, serviceDir, NS, SE_REAPLICAN };
