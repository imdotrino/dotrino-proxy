/**
 * §15: ENTERARSE de que los pilares tienen versión nueva.
 *
 * El proxio se despliega desde git en cada push, así que su propio código siempre es el de
 * `main`. Lo que se queda atrás son sus DEPENDENCIAS: van con versión exacta (§1.1) y nadie
 * las sube si nadie se entera. Así corrió meses con `@dotrino/vault` 0.52 mientras la bóveda
 * iba por la 0.78, y nadie lo vio (2026-09-30).
 *
 * Solo mira y lo dice en el log, una vez al día. Instalar lo decide una persona.
 */
const path = require('path');

const WATCHED = ['@dotrino/identity', '@dotrino/proxy-client', '@dotrino/vault'];

function installedVersion(pkg) {
    return require(path.join(__dirname, 'node_modules', pkg, 'package.json')).version;
}

async function startUpdateWatch(log = console.log) {
    const { watchForUpdate } = await import('@dotrino/update');
    const handles = [];
    for (const pkg of WATCHED) {
        handles.push(watchForUpdate({
            current: installedVersion(pkg), source: 'npm', pkg,
            onNewer: (r) => log(`[update] ${pkg} ${r.version} is available (running ${r.current}): bump it in package.json`)
        }));
    }
    return handles;
}

module.exports = { startUpdateWatch, installedVersion, WATCHED };
