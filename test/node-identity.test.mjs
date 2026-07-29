import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const crypto = require('crypto');
const {
    derivePrefix, isValidPrefix, signBody, verifyBody, ReplayWindow, newNonce, PREFIX_LEN, ALLOWED_CHARS
} = require('../nodeIdentity');
const { PeerRegistry } = require('../peers');

// Identidad de nodo falsa con la misma forma que la del vault
// (`service-identity.json` → device: {publickey, privateJwk}).
function makeNodeIdentity(prefix) {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicJwk = kp.publicKey.export({ format: 'jwk' });
    const privateJwk = kp.privateKey.export({ format: 'jwk' });
    const pubkey = JSON.stringify(publicJwk);
    return { pubkey, privateJwk, prefix: prefix || derivePrefix(pubkey) };
}

// Persistencia en memoria con la misma superficie que usa PeerRegistry, con el
// índice único de prefijo que impone SQLite.
function makeMemoryPersist() {
    const rows = new Map();
    return {
        rows,
        loadPeerNodes: () => Array.from(rows.values()),
        pinPeerNode(url, pubkey, prefix, now) {
            for (const r of rows.values()) {
                if (r.prefix === prefix && r.url !== url) throw new Error('UNIQUE constraint failed: peer_nodes.prefix');
            }
            rows.set(url, { url, pubkey, prefix, pinned_at: now, updated_at: now });
        },
        touchPeerNode(url, now) { const r = rows.get(url); if (r) r.updated_at = now; },
        deletePeerNode(url) { rows.delete(url); }
    };
}

describe('identidad de nodo', () => {
    it('deriva un prefijo válido y determinista de la pubkey', () => {
        const id = makeNodeIdentity();
        expect(isValidPrefix(id.prefix)).toBe(true);
        expect(id.prefix).toHaveLength(PREFIX_LEN);
        expect(derivePrefix(id.pubkey)).toBe(id.prefix);
        for (const c of id.prefix) expect(ALLOWED_CHARS).toContain(c);
    });

    it('pubkeys distintas dan prefijos que no tienen por qué coincidir', () => {
        const prefixes = new Set(Array.from({ length: 40 }, () => makeNodeIdentity().prefix));
        // Con 1.225 prefijos posibles y 40 muestras habrá algún choque de vez en
        // cuando, pero no puede colapsar todo a un único valor.
        expect(prefixes.size).toBeGreaterThan(20);
    });

    it('firma y verifica un cuerpo, y rechaza el cuerpo alterado', () => {
        const id = makeNodeIdentity();
        const body = { v: 1, op: 'deliver', toPubkey: 'pk-a', ts: Date.now(), nonce: newNonce() };
        const sig = signBody(id, body);
        expect(verifyBody(body, sig, id.pubkey)).toBe(true);
        expect(verifyBody({ ...body, toPubkey: 'pk-b' }, sig, id.pubkey)).toBe(false);
    });

    it('una firma de OTRO nodo no vale (no se puede hablar en nombre ajeno)', () => {
        const a = makeNodeIdentity();
        const b = makeNodeIdentity();
        const body = { v: 1, op: 'deliver', ts: Date.now(), nonce: newNonce() };
        expect(verifyBody(body, signBody(a, body), b.pubkey)).toBe(false);
    });

    it('rechaza firmas mal formadas sin lanzar', () => {
        const id = makeNodeIdentity();
        const body = { v: 1, ts: Date.now() };
        expect(verifyBody(body, 'no-es-base64-valido', id.pubkey)).toBe(false);
        expect(verifyBody(body, signBody(id, body), 'no-es-jwk')).toBe(false);
        expect(verifyBody(body, signBody(id, body), JSON.stringify({ kty: 'RSA' }))).toBe(false);
    });
});

describe('anti-replay s2s', () => {
    let win;
    beforeEach(() => { win = new ReplayWindow(60_000); });

    it('acepta una trama fresca una sola vez', () => {
        const n = newNonce();
        expect(win.accept(n, Date.now())).toBe(true);
        expect(win.accept(n, Date.now())).toBe(false);
    });

    it('rechaza tramas fuera de la ventana de tiempo', () => {
        expect(win.accept(newNonce(), Date.now() - 120_000)).toBe(false);
        expect(win.accept(newNonce(), Date.now() + 120_000)).toBe(false);
        expect(win.accept(newNonce(), NaN)).toBe(false);
    });

    it('rechaza nonces ausentes o triviales', () => {
        expect(win.accept(undefined, Date.now())).toBe(false);
        expect(win.accept('abc', Date.now())).toBe(false);
    });
});

describe('registro de peers', () => {
    let persist, registry, self;

    beforeEach(() => {
        persist = makeMemoryPersist();
        self = makeNodeIdentity('K7');
        registry = new PeerRegistry({ urls: [], identity: self, persist, log: () => {} });
    });

    function announcementOf(id, url) {
        const body = { v: 1, prefix: id.prefix, pubkey: id.pubkey, url, ts: Date.now(), nonce: newNonce() };
        return { body, signature: signBody(id, body) };
    }

    it('acepta un anuncio autofirmado y lo pinea', () => {
        const other = makeNodeIdentity('M2');
        const peer = PeerRegistry.parseAnnouncement(announcementOf(other, 'https://p2'), 'https://p2');
        expect(peer).toMatchObject({ url: 'https://p2', pubkey: other.pubkey, prefix: 'M2' });
        expect(registry.adopt(peer).status).toBe('pinned');
        expect(registry.byNodePrefix('M2').url).toBe('https://p2');
        expect(registry.byNodePubkey(other.pubkey).prefix).toBe('M2');
    });

    it('rechaza un anuncio cuya firma no corresponde a la pubkey declarada', () => {
        const other = makeNodeIdentity('M2');
        const impostor = makeNodeIdentity('M2');
        const body = { v: 1, prefix: 'M2', pubkey: other.pubkey, url: 'https://p2', ts: Date.now(), nonce: newNonce() };
        const forged = { body, signature: signBody(impostor, body) };
        expect(PeerRegistry.parseAnnouncement(forged, 'https://p2')).toBeNull();
    });

    it('rechaza anuncios viejos y con prefijo mal formado', () => {
        const other = makeNodeIdentity('M2');
        const stale = { v: 1, prefix: 'M2', pubkey: other.pubkey, url: 'https://p2', ts: Date.now() - 10 * 60 * 1000 };
        expect(PeerRegistry.parseAnnouncement({ body: stale, signature: signBody(other, stale) }, 'https://p2')).toBeNull();
        const bad = { v: 1, prefix: 'm2!', pubkey: other.pubkey, url: 'https://p2', ts: Date.now() };
        expect(PeerRegistry.parseAnnouncement({ body: bad, signature: signBody(other, bad) }, 'https://p2')).toBeNull();
    });

    it('NO deja que otra pubkey se quede con un prefijo ya pineado', () => {
        const legit = makeNodeIdentity('M2');
        const hostile = makeNodeIdentity('M2');
        expect(registry.adopt({ url: 'https://legit', pubkey: legit.pubkey, prefix: 'M2' }).status).toBe('pinned');
        const r = registry.adopt({ url: 'https://hostil', pubkey: hostile.pubkey, prefix: 'M2' });
        expect(r.status).toBe('conflict');
        // El legítimo sigue siendo el dueño del prefijo.
        expect(registry.byNodePrefix('M2').url).toBe('https://legit');
    });

    it('NO deja que un peer reclame MI prefijo', () => {
        const hostile = makeNodeIdentity('K7');
        const r = registry.adopt({ url: 'https://hostil', pubkey: hostile.pubkey, prefix: 'K7' });
        expect(r.status).toBe('conflict');
        expect(r.reason).toMatch(/MI prefijo/);
    });

    it('NO cambia la pubkey pineada de un URL por su cuenta', () => {
        const legit = makeNodeIdentity('M2');
        const rotated = makeNodeIdentity('M2');
        registry.adopt({ url: 'https://p2', pubkey: legit.pubkey, prefix: 'M2' });
        const r = registry.adopt({ url: 'https://p2', pubkey: rotated.pubkey, prefix: 'M2' });
        expect(r.status).toBe('conflict');
        expect(registry.byNodePubkey(legit.pubkey)).not.toBeNull();
        expect(registry.byNodePubkey(rotated.pubkey)).toBeNull();
    });

    it('re-adoptar el mismo peer es idempotente', () => {
        const other = makeNodeIdentity('M2');
        const peer = { url: 'https://p2', pubkey: other.pubkey, prefix: 'M2' };
        expect(registry.adopt(peer).status).toBe('pinned');
        expect(registry.adopt(peer).status).toBe('known');
        expect(registry.known()).toHaveLength(1);
    });

    it('rehidrata los peers pineados desde disco', () => {
        const other = makeNodeIdentity('M2');
        registry.adopt({ url: 'https://p2', pubkey: other.pubkey, prefix: 'M2' });
        const fresh = new PeerRegistry({ urls: [], identity: self, persist, log: () => {} });
        expect(fresh.load()).toBe(1);
        expect(fresh.byNodePrefix('M2').pubkey).toBe(other.pubkey);
    });

    it('descubre por HTTP y pinea; un peer caído no rompe nada', async () => {
        const other = makeNodeIdentity('M2');
        const reg = new PeerRegistry({
            urls: ['https://p2', 'https://caido'], identity: self, persist, log: () => {},
            fetchImpl: async (url) => {
                if (url.startsWith('https://caido')) throw new Error('ECONNREFUSED');
                return { ok: true, json: async () => announcementOf(other, 'https://p2') };
            }
        });
        const out = await reg.discoverAll();
        expect(out.find(o => o.url === 'https://p2').status).toBe('pinned');
        expect(out.find(o => o.url === 'https://caido').status).toBe('unreachable');
        expect(reg.byNodePrefix('M2')).not.toBeNull();
    });

    it('el anuncio propio va firmado y se verifica con la propia pubkey', () => {
        const a = registry.selfAnnouncement('https://yo');
        expect(a.body.prefix).toBe('K7');
        expect(verifyBody(a.body, a.signature, self.pubkey)).toBe(true);
        expect(PeerRegistry.parseAnnouncement(a, 'https://yo')).toMatchObject({ prefix: 'K7' });
    });
});
