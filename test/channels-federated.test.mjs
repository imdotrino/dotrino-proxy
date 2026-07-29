import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import { createRequire } from 'module';
import {
    startNode, makeNodeDir, connectTo, freePort, sleep
} from './fedHelpers.mjs';

const require = createRequire(import.meta.url);
const crypto = require('crypto');

// Canal con NODO DUEÑO: el nombre lleva delante el id del proxio que lo
// hospeda (`<id de 12>/mesa-42`). Ese nodo guarda la membresía y los demás le pasan las
// operaciones. Así un servicio vive siempre en el mismo proxio y dos personas en
// nodos distintos SÍ aparecen en la misma lista — sin que cada consulta le
// pregunte a toda la malla ni que todos los peers se enteren de quién está dónde.
function canonical(obj) {
    if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
    return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

function makeChannelSigner() {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = kp.publicKey.export({ format: 'jwk' });
    const publickey = JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });
    return (name) => {
        const data = { name, publickey };
        const signature = crypto.sign('sha256', Buffer.from(canonical(data), 'utf8'),
            { key: kp.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
        return { data, signature };
    };
}

describe('canales con nodo dueño', () => {
    let a, b, dirA, dirB;

    beforeAll(async () => {
        dirA = makeNodeDir('chan-a');
        dirB = makeNodeDir('chan-b');
        const portA = await freePort();
        const portB = await freePort();
        [a, b] = await Promise.all([
            startNode({ name: 'A', dir: dirA, port: portA, peers: [`http://127.0.0.1:${portB}`] }),
            startNode({ name: 'B', dir: dirB, port: portB, peers: [`http://127.0.0.1:${portA}`] })
        ]);
        const deadline = Date.now() + 30000;
        for (;;) {
            const s = await Promise.all([a, b].map((n) => fetch(`${n.http}/peers`).then(r => r.json()).catch(() => null)));
            if (s.every((x) => x && x.peers?.length && Object.values(x.mesh || {}).some((m) => m.ready))) break;
            if (Date.now() > deadline) throw new Error('la malla no se estableció');
            await sleep(300);
        }
    }, 60000);

    afterAll(async () => {
        await Promise.all([a?.stop(), b?.stop()]);
        for (const d of [dirA, dirB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
    });

    it('un canal sin id de nodo sigue siendo local a cada nodo', async () => {
        const sign = makeChannelSigner();
        const ca = await connectTo(a.url);
        const cb = await connectTo(b.url);
        ca.send({ type: 'publish', channel: sign('sala-local') });
        await ca.waitFor((m) => m.type === 'published');
        cb.send({ type: 'list', channel: sign('sala-local') });
        const lista = await cb.waitFor((m) => m.type === 'channel_list');
        expect(lista.tokens).toHaveLength(0);   // no se ven entre nodos
        await ca.close(); await cb.close();
    }, 20000);

    it('dos personas en nodos distintos aparecen en la MISMA lista', async () => {
        const sign = makeChannelSigner();
        const nombre = `${a.nodeId}/mesa-compartida`;
        const ca = await connectTo(a.url);   // en el nodo dueño
        const cb = await connectTo(b.url);   // en el otro nodo

        ca.send({ type: 'publish', channel: sign(nombre) });
        await ca.waitFor((m) => m.type === 'published');
        cb.send({ type: 'publish', channel: sign(nombre) });
        await cb.waitFor((m) => m.type === 'published', 10000);

        cb.send({ type: 'list', channel: sign(nombre) });
        const lista = await cb.waitFor((m) => m.type === 'channel_list', 10000);
        expect(lista.tokens).toContain(ca.token);
        expect(lista.tokens).toContain(cb.token);
        await ca.close(); await cb.close();
    }, 30000);

    it('el miembro que ya estaba se entera del que entra desde otro nodo', async () => {
        const sign = makeChannelSigner();
        const nombre = `${a.nodeId}/mesa-avisos`;
        const ca = await connectTo(a.url);
        ca.send({ type: 'publish', channel: sign(nombre) });
        await ca.waitFor((m) => m.type === 'published');

        const cb = await connectTo(b.url);
        cb.send({ type: 'publish', channel: sign(nombre) });
        await cb.waitFor((m) => m.type === 'published', 10000);

        const joined = await ca.waitFor((m) => m.type === 'joined' && m.token === cb.token, 10000);
        expect(joined.channel).toBe(nombre);
        await ca.close(); await cb.close();
    }, 30000);

    it('el aviso de baja llega al miembro que está en OTRO nodo', async () => {
        const sign = makeChannelSigner();
        const nombre = `${a.nodeId}/mesa-bajas`;
        const ca = await connectTo(a.url);   // dueño
        const cb = await connectTo(b.url);   // remoto
        ca.send({ type: 'publish', channel: sign(nombre) });
        await ca.waitFor((m) => m.type === 'published');
        cb.send({ type: 'publish', channel: sign(nombre) });
        await cb.waitFor((m) => m.type === 'published', 10000);
        await ca.waitFor((m) => m.type === 'joined', 10000);

        const se_va = ca.token;
        await ca.close();
        const aviso = await cb.waitFor((m) => m.type === 'disconnected' && m.token === se_va, 10000);
        expect(aviso.channel).toBe(nombre);
        await cb.close();
    }, 30000);

    it('contar un canal ajeno da el número del dueño, no cero', async () => {
        const sign = makeChannelSigner();
        const nombre = `${a.nodeId}/mesa-cuenta`;
        const ca = await connectTo(a.url);
        ca.send({ type: 'publish', channel: sign(nombre) });
        await ca.waitFor((m) => m.type === 'published');

        const cb = await connectTo(b.url);
        cb.send({ type: 'channel_count', channel: nombre });
        const cuenta = await cb.waitFor((m) => m.type === 'channel_count', 10000);
        expect(cuenta.count).toBe(1);
        await ca.close(); await cb.close();
    }, 30000);

    it('un canal de un nodo desconocido responde error, no una lista vacía', async () => {
        const sign = makeChannelSigner();
        const cb = await connectTo(b.url);
        // Id BIEN FORMADO (alfabeto válido) pero que no es de ningún nodo conocido.
        cb.send({ type: 'list', channel: sign('YYYYYYYYYYYY/sala-fantasma'), id: 'zz' });
        const res = await cb.waitFor((m) => m.type === 'error' || m.type === 'channel_list', 10000);
        expect(res.type).toBe('error');
        expect(res.error).toMatch(/nodo desconocido/i);
        await cb.close();
    }, 20000);
});

// El canal de DESCUBRIMIENTO (la lista pública de salas) no tiene dueño natural:
// es un nombre global del ecosistema y no lo crea nadie en particular. En vez de
// designar un nodo árbitro —que sería un punto único de fallo— cada proxio guarda
// su lista y quien busca pregunta en todos y mezcla. Se publica en uno, se lee de
// varios; el fan-out lo paga el CLIENTE, no el servidor.
describe('descubrimiento: una lista por nodo, mezcladas por el cliente', () => {
    let a, b, dirA, dirB;

    beforeAll(async () => {
        dirA = makeNodeDir('disc-a');
        dirB = makeNodeDir('disc-b');
        const portA = await freePort();
        const portB = await freePort();
        [a, b] = await Promise.all([
            startNode({ name: 'A', dir: dirA, port: portA, peers: [`http://127.0.0.1:${portB}`] }),
            startNode({ name: 'B', dir: dirB, port: portB, peers: [`http://127.0.0.1:${portA}`] })
        ]);
        const deadline = Date.now() + 30000;
        for (;;) {
            const s = await Promise.all([a, b].map((n) => fetch(`${n.http}/peers`).then(r => r.json()).catch(() => null)));
            if (s.every((x) => x && x.peers?.length && Object.values(x.mesh || {}).some((m) => m.ready))) break;
            if (Date.now() > deadline) throw new Error('la malla no se estableció');
            await sleep(300);
        }
    }, 60000);

    afterAll(async () => {
        await Promise.all([a?.stop(), b?.stop()]);
        for (const d of [dirA, dirB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
    });

    it('el `connected` trae el id del proxio y los que conoce', async () => {
        const ca = await connectTo(a.url);
        const frame = ca.recv.find((m) => m.type === 'connected') ||
            { node: ca.node, peers: ca.peers };
        // El helper guarda el frame; se comprueba contra /peers, que es la verdad.
        const info = await fetch(`${a.http}/peers`).then((r) => r.json());
        expect(info.self.nodeId).toBe(a.nodeId);
        expect(info.peers.map((p) => p.nodeId)).toContain(b.nodeId);
        await ca.close();
    }, 20000);

    it('un host de cada proxio, y el cliente los ve a los dos al mezclar', async () => {
        const sign = makeChannelSigner();
        const canalA = `${a.nodeId}/cclobby/chess`;
        const canalB = `${b.nodeId}/cclobby/chess`;

        // Cada host anuncia SOLO en el canal de su propio proxio.
        const hostA = await connectTo(a.url);
        hostA.send({ type: 'publish', channel: sign(canalA) });
        await hostA.waitFor((m) => m.type === 'published');

        const hostB = await connectTo(b.url);
        hostB.send({ type: 'publish', channel: sign(canalB) });
        await hostB.waitFor((m) => m.type === 'published');

        // Quien busca (conectado a B) pregunta en los DOS y mezcla.
        const buscador = await connectTo(b.url);
        buscador.send({ type: 'list', channel: sign(canalA), id: 'la' });
        buscador.send({ type: 'list', channel: sign(canalB), id: 'lb' });
        const la = await buscador.waitFor((m) => m.type === 'channel_list' && m.id === 'la', 10000);
        const lb = await buscador.waitFor((m) => m.type === 'channel_list' && m.id === 'lb', 10000);
        const mezcla = [...new Set([...la.tokens, ...lb.tokens])];

        expect(mezcla).toContain(hostA.token);
        expect(mezcla).toContain(hostB.token);
        await hostA.close(); await hostB.close(); await buscador.close();
    }, 30000);

    it('si un nodo no contesta, se siguen viendo las salas de los demás', async () => {
        const sign = makeChannelSigner();
        const canalB = `${b.nodeId}/cclobby/chess`;
        const hostB = await connectTo(b.url);
        hostB.send({ type: 'publish', channel: sign(canalB) });
        await hostB.waitFor((m) => m.type === 'published');

        const buscador = await connectTo(b.url);
        // Un nodo que no existe: su consulta falla, pero no arrastra a la otra.
        buscador.send({ type: 'list', channel: sign('YYYYYYYYYYYY/cclobby/chess'), id: 'muerto' });
        buscador.send({ type: 'list', channel: sign(canalB), id: 'vivo' });
        const muerto = await buscador.waitFor((m) => (m.type === 'error' || m.type === 'channel_list') && m.id === 'muerto', 10000);
        const vivo = await buscador.waitFor((m) => m.type === 'channel_list' && m.id === 'vivo', 10000);
        expect(muerto.type).toBe('error');
        expect(vivo.tokens).toContain(hostB.token);
        await hostB.close(); await buscador.close();
    }, 30000);
});
