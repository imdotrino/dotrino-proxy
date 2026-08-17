/**
 * LA FEDERACIÓN PUEDE LLEGAR TARDE, y tiene que levantarse igual.
 *
 * El proxio nunca espera a la bóveda para arrancar (se necesita a sí mismo para
 * hablar con ella), así que su configuración llega SIEMPRE después de que ya está
 * escuchando. Mientras `PROXY_PEERS`/`PROXY_PUBLIC_URL` se leían solo al construir,
 * eso obligaba a repetirlas a mano en el `.env` de cada VPS —justo las dos que
 * distinguen a una máquina de otra— y lo que guardaba la bóveda no servía para nada
 * hasta el siguiente reinicio.
 *
 * Aquí el nodo A arranca SIN peers y sin URL pública, como si su `.env` no las
 * tuviera, y las recibe después: `applyFederationConfig()` es lo que corre el
 * proxio cuando aterriza el bundle de la bóveda (`vaultSecrets.onSecrets`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
    startNode, writeFakeVaultIdentity, connectTo, connectIdentified, makeUser, freePort, sleep
} from './fedHelpers.mjs';

const require = createRequire(import.meta.url);

// ANTES de requerir server.js: lee el entorno al cargar (SQLite y dir del vault).
// Y sin PROXY_PEERS/PROXY_PUBLIC_URL a propósito: ese es el escenario.
const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'dotrino-fed-late-a-'));
writeFakeVaultIdentity(path.join(dirA, 'vault-service'));
process.env.PROXY_DB_FILE = ':memory:';
process.env.VAULT_SERVICE_DIR = path.join(dirA, 'vault-service');
process.env.RATE_LIMIT_DISABLED = '1';
process.env.NODE_ENV = 'test';
delete process.env.PROXY_PEERS;
delete process.env.PROXY_PUBLIC_URL;

const { start, stop, applyFederationConfig } = require('../server');

const peersOf = (http) => fetch(`${http}/peers`).then((r) => r.json()).catch(() => null);

async function waitMeshReady(endpoints, ms = 30000) {
    const deadline = Date.now() + ms;
    for (;;) {
        const states = await Promise.all(endpoints.map(peersOf));
        if (states.every((s) => s && s.peers?.length && Object.values(s.mesh || {}).some((m) => m.ready))) return states;
        if (Date.now() > deadline) throw new Error('la malla no se estableció: ' + JSON.stringify(states));
        await sleep(300);
    }
}

describe('la federación se configura desde la bóveda (sin .env)', () => {
    let portA, portB, httpA, urlA, b, dirB;

    beforeAll(async () => {
        // El puerto de B se reserva antes para poder nombrarlo en la configuración
        // que «manda la bóveda», igual que se escribe en el cajón del aparato.
        portB = await freePort();
        portA = await start(0);
        httpA = `http://127.0.0.1:${portA}`;
        urlA = `ws://127.0.0.1:${portA}`;
        dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'dotrino-fed-late-b-'));
        writeFakeVaultIdentity(path.join(dirB, 'vault-service'));
        b = await startNode({ name: 'B', dir: dirB, port: portB, peers: [httpA] });
    }, 60000);

    afterAll(async () => {
        await b?.stop();
        await stop();
        for (const d of [dirA, dirB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
    });

    it('arranca sin peers: el transporte funciona igual, sin federación', async () => {
        const s = await peersOf(httpA);
        expect(s.configured).toEqual([]);
        expect(Object.keys(s.mesh || {})).toEqual([]);
        // Y sin URL pública no hay nada que pinear todavía: /node lo dice.
        const c = await connectTo(urlA);
        expect(c.token).toBeTruthy();
        await c.close();
    });

    it('cuando llega la configuración de la bóveda, levanta la malla y cruza un mensaje', async () => {
        process.env.PROXY_PEERS = `http://127.0.0.1:${portB}`;
        process.env.PROXY_PUBLIC_URL = httpA;
        applyFederationConfig(() => {});

        const [sa] = await waitMeshReady([httpA, b.http]);
        expect(sa.configured).toEqual([`http://127.0.0.1:${portB}`]);

        // La prueba de que federa de verdad: un usuario identificado en A recibe
        // lo que le mandan desde B, que solo puede llegar por la malla.
        const alice = makeUser();
        const ca = await connectIdentified(urlA, alice);
        const cb = await connectTo(b.url);
        const payload = 'tarde-' + Date.now();
        cb.send({ to_publickey: alice.publickey, message: payload });
        const got = await ca.waitFor((m) => m.type === 'message' && m.message === payload, 15000);
        expect(got.message).toBe(payload);
        await ca.close(); await cb.close();
    }, 60000);

    it('volver a aplicar lo mismo no reconecta nada (es idempotente)', async () => {
        const antes = Object.values((await peersOf(httpA)).mesh)[0];
        applyFederationConfig(() => {});
        await sleep(300);
        const despues = Object.values((await peersOf(httpA)).mesh)[0];
        // Un enlace nuevo empezaría de cero: mismas reconexiones = mismo enlace.
        expect(despues.reconnects).toBe(antes.reconnects);
    });
});
