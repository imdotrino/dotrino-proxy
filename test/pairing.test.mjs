import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import { createRequire } from 'module';
import {
    startNode, makeNodeDir, connectTo, connectIdentified, makeUser, freePort, sleep
} from './fedHelpers.mjs';

const require = createRequire(import.meta.url);
const { PairingCodes, normalizeCode } = require('../pairingCodes');

describe('citas de emparejamiento (unidad)', () => {
    let codes;
    beforeEach(() => { codes = new PairingCodes(); });

    it('emite un código de 6 caracteres con el prefijo del nodo delante', () => {
        const r = codes.create({ instance: 'K7abc', pubkey: 'pk', nodePrefix: 'K7' });
        expect(r.code).toMatch(/^K7[1-9A-Z]{4}$/);
        expect(r.expiresAt).toBeGreaterThan(Date.now());
    });

    it('canjea una vez y solo una (se quema al usarse)', () => {
        const { code } = codes.create({ instance: 'K7abc', pubkey: 'pk', nodePrefix: 'K7' });
        expect(codes.redeem(code)).toMatchObject({ instance: 'K7abc', pubkey: 'pk' });
        expect(codes.redeem(code).error).toMatch(/no válido o ya usado/);
    });

    it('acepta el código tecleado en minúsculas, con espacios y guiones', () => {
        const { code } = codes.create({ instance: 'K7abc', nodePrefix: 'K7' });
        const tecleado = code.slice(0, 3).toLowerCase() + '-' + code.slice(3).toLowerCase();
        expect(normalizeCode(tecleado)).toBe(code);
        expect(codes.redeem(tecleado).instance).toBe('K7abc');
    });

    it('caduca', () => {
        const { code } = codes.create({ instance: 'K7abc', nodePrefix: 'K7', ttlMs: 30 * 1000 });
        const entry = codes.codes.get(code);
        entry.expiresAt = Date.now() - 1;
        expect(codes.redeem(code).error).toMatch(/caducado/);
    });

    it('una cita viva por conexión: pedir otra invalida la anterior', () => {
        const a = codes.create({ instance: 'K7abc', nodePrefix: 'K7' });
        const b = codes.create({ instance: 'K7abc', nodePrefix: 'K7' });
        expect(a.code).not.toBe(b.code);
        expect(codes.redeem(a.code).error).toBeTruthy();
        expect(codes.redeem(b.code).instance).toBe('K7abc');
    });

    it('soltar la conexión invalida su cita', () => {
        const { code } = codes.create({ instance: 'K7abc', nodePrefix: 'K7' });
        codes.release('K7abc');
        expect(codes.redeem(code).error).toBeTruthy();
    });

    it('sin prefijo de nodo no emite (no sería resoluble por nadie)', () => {
        expect(codes.create({ instance: 'x', nodePrefix: null })).toBeNull();
    });

    it('peek no quema el código', () => {
        const { code } = codes.create({ instance: 'K7abc', nodePrefix: 'K7' });
        expect(codes.peek(code).instance).toBe('K7abc');
        expect(codes.redeem(code).instance).toBe('K7abc');
    });
});

describe('citas entre nodos', () => {
    let a, b, dirA, dirB;

    beforeAll(async () => {
        dirA = makeNodeDir('pair-a');
        dirB = makeNodeDir('pair-b');
        const portA = await freePort();
        const portB = await freePort();
        [a, b] = await Promise.all([
            startNode({ name: 'A', dir: dirA, port: portA, prefix: 'K7', peers: [`http://127.0.0.1:${portB}`] }),
            startNode({ name: 'B', dir: dirB, port: portB, prefix: 'M2', peers: [`http://127.0.0.1:${portA}`] })
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

    it('el código lleva el prefijo del nodo que lo emitió', async () => {
        const ca = await connectTo(a.url);
        ca.send({ type: 'pair-code', id: 'pc-1' });
        const res = await ca.waitFor((m) => m.type === 'pair-code');
        expect(res.code).toMatch(/^K7[1-9A-Z]{4}$/);
        expect(res.node).toBe('K7');
        await ca.close();
    });

    it('se canjea desde el OTRO nodo y devuelve la instancia correcta', async () => {
        const alice = makeUser();
        const ca = await connectIdentified(a.url, alice);
        ca.send({ type: 'pair-code' });
        const { code } = await ca.waitFor((m) => m.type === 'pair-code');

        const cb = await connectTo(b.url);
        cb.send({ type: 'pair-redeem', code, id: 'pr-1' });
        const res = await cb.waitFor((m) => m.type === 'pair-redeem', 10000);
        expect(res.ok).toBe(true);
        expect(res.instance).toBe(ca.token);
        expect(res.publickey).toBe(alice.publickey);

        // Y con esa instancia ya se le puede escribir a través de la malla.
        const payload = 'tras-la-cita-' + Date.now();
        cb.send({ to: [res.instance], message: payload });
        const got = await ca.waitFor((m) => m.type === 'message' && m.message === payload, 10000);
        expect(got.message).toBe(payload);
        await ca.close(); await cb.close();
    }, 30000);

    it('un código ya canjeado no vale una segunda vez, ni desde otro nodo', async () => {
        const ca = await connectTo(a.url);
        ca.send({ type: 'pair-code' });
        const { code } = await ca.waitFor((m) => m.type === 'pair-code');

        const cb = await connectTo(b.url);
        cb.send({ type: 'pair-redeem', code, id: 'x1' });
        expect((await cb.waitFor((m) => m.type === 'pair-redeem' && m.id === 'x1', 10000)).ok).toBe(true);
        cb.send({ type: 'pair-redeem', code, id: 'x2' });
        const segundo = await cb.waitFor((m) => m.type === 'pair-redeem' && m.id === 'x2', 10000);
        expect(segundo.ok).toBe(false);
        await ca.close(); await cb.close();
    }, 30000);

    it('un código de un nodo desconocido se rechaza sin pregonarlo', async () => {
        const cb = await connectTo(b.url);
        cb.send({ type: 'pair-redeem', code: 'ZZ1234', id: 'unk' });
        const res = await cb.waitFor((m) => m.type === 'pair-redeem', 10000);
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/nodo desconocido/i);
        await cb.close();
    }, 20000);

    it('desconectarse invalida la cita en el nodo dueño', async () => {
        const ca = await connectTo(a.url);
        ca.send({ type: 'pair-code' });
        const { code } = await ca.waitFor((m) => m.type === 'pair-code');
        await ca.close();
        await sleep(300);

        const cb = await connectTo(b.url);
        cb.send({ type: 'pair-redeem', code, id: 'dead' });
        const res = await cb.waitFor((m) => m.type === 'pair-redeem', 10000);
        expect(res.ok).toBe(false);
        await cb.close();
    }, 30000);
});
