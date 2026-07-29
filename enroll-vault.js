#!/usr/bin/env node
/**
 * Enrola ESTE proxy como servicio del vault (una sola vez).
 *
 *   1. En el vault:   dotrino-vault pair --service proxy
 *      (imprime un QR y un payload JSON — copia el payload)
 *   2. Aquí:          node enroll-vault.js '<payload JSON>'
 *   3. En el vault:   dotrino-vault approve <código que imprime este script>
 *
 * Persiste la identidad del servicio en VAULT_SERVICE_DIR (default
 * ./vault-service): llave propia + cert con scope SOLO vault:secrets:proxy.
 * Después: dotrino-vault secret set proxy TURN_KEY_ID … y reiniciar el proxy.
 */
const { serviceDir, NS } = require('./vaultSecrets');

async function main() {
    const arg = process.argv[2];
    if (!arg) {
        console.error("uso: node enroll-vault.js '<payload JSON del QR>'   (lo imprime `dotrino-vault pair --service proxy`)");
        process.exit(2);
    }
    const { enrollService } = await import('@dotrino/vault/service');
    const dir = serviceDir();
    await enrollService({
        qr: arg, ns: NS, dir,
        // Un agente tiene UNA identidad y se la cede el vault: enrolar de nuevo
        // REEMPLAZA la que hubiera. En el proxy eso tiene un precio que hay que
        // decir antes, no después: esta misma llave es su identidad de red, y su
        // id de nodo SALE de ella (nodeIdentity.js). Cambiarla significa que el
        // nodo pasa a llamarse distinto: las instancias y citas vivas mueren, y
        // los peers que lo tenían pineado lo rechazan hasta re-pinearlo a mano
        // (que es a propósito: así es como se echa a un nodo comprometido).
        onReplace: (prev) => {
            console.log(`\n⚠ Este proxio YA estaba enrolado (dispositivo ${prev.deviceId}, del ${new Date(prev.enrolledAt).toISOString().slice(0, 10)}).`);
            console.log('  Se descarta esa identidad y con ella el ID DE NODO actual:');
            console.log('  · las instancias y citas emitidas dejan de resolver;');
            console.log('  · los peers federados lo rechazan hasta que los re-pineen.');
            console.log('  Si sólo querías recargar los secretos, NO enroles: reinicia el proxio.\n');
        },
        onCode: ({ deviceId, code }) => {
            console.log(`\nDispositivo del proxy: ${deviceId}`);
            console.log(`Aprueba en el vault:   dotrino-vault approve ${code}\n`);
        }
    });
    console.log(`Proxy enrolado al vault. Identidad en ${dir}.`);
    console.log('Carga los secretos en el vault y reinicia el proxy:');
    console.log('  dotrino-vault secret set proxy TURN_KEY_ID <id>');
    console.log('  dotrino-vault secret set proxy TURN_KEY_API_TOKEN <token>');
}

main().catch((e) => { console.error('Enrolamiento falló:', e.message); process.exit(1); });
