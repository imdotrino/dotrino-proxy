import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const crypto = require('crypto');
const {
    deriveNodeId, isValidNodeId, nodeIdMatches, hintOf, canonicalPubkeyBytes,
    signBody, verifyBody, ReplayWindow, newNonce, NODE_ID_LEN, CODE_HINT_LEN
} = require('../nodeIdentity');
const { ALPHABET } = require('../alphabet');
const { PeerRegistry } = require('../peers');

/** Identidad de nodo con la misma forma que la del vault (device.publickey/privateJwk). */
function makeNodeIdentity() {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicJwk = kp.publicKey.export({ format: 'jwk' });
    const privateJwk = kp.privateKey.export({ format: 'jwk' });
    const pubkey = JSON.stringify(publicJwk);
    const nodeId = deriveNodeId(pubkey);
    return { pubkey, privateJwk, nodeId, hint: hintOf(nodeId), publicJwk };
}

function makeMemoryPersist() {
    const rows = new Map();
    return {
        rows,
        loadPeerNodes: () => Array.from(rows.values()),
        pinPeerNode(url, pubkey, nodeId, now) {
            for (const r of rows.values()) {
                if (r.node_id === nodeId && r.url !== url) throw new Error('UNIQUE constraint failed: peer_nodes.node_id');
            }
            rows.set(url, { url, pubkey, node_id: nodeId, pinned_at: now, updated_at: now });
        },
        touchPeerNode(url, now) { const r = rows.get(url); if (r) r.updated_at = now; },
        deletePeerNode(url) { rows.delete(url); }
    };
}

describe('id de nodo derivado', () => {
    it('mide NODE_ID_LEN y usa solo el alfabeto permitido', () => {
        const id = makeNodeIdentity().nodeId;
        expect(isValidNodeId(id)).toBe(true);
        expect(id).toHaveLength(NODE_ID_LEN);
        for (const c of id) expect(ALPHABET).toContain(c);
    });

    it('es determinista: la misma llave da siempre el mismo id', () => {
        const { pubkey, nodeId } = makeNodeIdentity();
        expect(deriveNodeId(pubkey)).toBe(nodeId);
        expect(deriveNodeId(pubkey)).toBe(nodeId);
    });

    // REGRESIÓN: derivarlo del JWK SERIALIZADO era inestable. El mismo par de
    // llaves exportado por Node y por el navegador produce strings con los campos
    // en otro orden (documentado en dotrino-vault/lib/src/invite.js), así que el
    // id cambiaba al re-exportar la MISMA llave. Se deriva del punto comprimido.
    it('NO cambia si la JWK trae los campos en otro orden o con extras', () => {
        const { publicJwk, nodeId } = makeNodeIdentity();
        const reordenada = JSON.stringify({
            y: publicJwk.y, crv: 'P-256', x: publicJwk.x, kty: 'EC', ext: true, key_ops: ['verify']
        });
        expect(deriveNodeId(reordenada)).toBe(nodeId);
    });

    it('la forma canónica son 33 bytes SEC1 comprimidos', () => {
        const { pubkey } = makeNodeIdentity();
        const bytes = canonicalPubkeyBytes(pubkey);
        expect(bytes).toHaveLength(33);
        expect([0x02, 0x03]).toContain(bytes[0]);
    });

    it('llaves distintas dan ids distintos', () => {
        const ids = new Set(Array.from({ length: 50 }, () => makeNodeIdentity().nodeId));
        expect(ids.size).toBe(50);
    });

    it('nodeIdMatches ata el id a la llave, y rechaza el ajeno', () => {
        const a = makeNodeIdentity();
        const b = makeNodeIdentity();
        expect(nodeIdMatches(a.nodeId, a.pubkey)).toBe(true);
        expect(nodeIdMatches(b.nodeId, a.pubkey)).toBe(false);
        expect(nodeIdMatches('nada', a.pubkey)).toBe(false);
        expect(nodeIdMatches(a.nodeId, 'no-es-jwk')).toBe(false);
    });

    it('el filtro del código corto son los primeros caracteres del id', () => {
        const { nodeId, hint } = makeNodeIdentity();
        expect(hint).toBe(nodeId.slice(0, CODE_HINT_LEN));
        expect(hint).toHaveLength(CODE_HINT_LEN);
    });
});

describe('firmas de nodo', () => {
    it('firma y verifica, y rechaza el cuerpo alterado', () => {
        const id = makeNodeIdentity();
        const body = { v: 1, op: 'deliver', toPubkey: 'pk-a', ts: Date.now(), nonce: newNonce() };
        const sig = signBody(id, body);
        expect(verifyBody(body, sig, id.pubkey)).toBe(true);
        expect(verifyBody({ ...body, toPubkey: 'pk-b' }, sig, id.pubkey)).toBe(false);
    });

    it('una firma de OTRO nodo no vale', () => {
        const a = makeNodeIdentity(); const b = makeNodeIdentity();
        const body = { v: 1, ts: Date.now(), nonce: newNonce() };
        expect(verifyBody(body, signBody(a, body), b.pubkey)).toBe(false);
    });

    it('rechaza firmas mal formadas sin lanzar', () => {
        const id = makeNodeIdentity();
        const body = { v: 1, ts: Date.now() };
        expect(verifyBody(body, 'no-es-base64-valido', id.pubkey)).toBe(false);
        expect(verifyBody(body, signBody(id, body), 'no-es-jwk')).toBe(false);
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

    it('rechaza tramas fuera de la ventana', () => {
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
        self = makeNodeIdentity();
        registry = new PeerRegistry({ urls: [], identity: self, persist, log: () => {} });
    });

    const announcementOf = (id, url) => {
        const body = { v: 1, nodeId: id.nodeId, pubkey: id.pubkey, url, ts: Date.now(), nonce: newNonce() };
        return { body, signature: signBody(id, body) };
    };

    it('acepta un anuncio autofirmado y lo pinea', () => {
        const other = makeNodeIdentity();
        const peer = PeerRegistry.parseAnnouncement(announcementOf(other, 'https://p2'), 'https://p2');
        expect(peer).toMatchObject({ url: 'https://p2', pubkey: other.pubkey, nodeId: other.nodeId });
        expect(registry.adopt(peer).status).toBe('pinned');
        expect(registry.byNodeId(other.nodeId).url).toBe('https://p2');
    });

    // ESTA es la comprobación que hace que no haga falta admitir a nadie: el id
    // se verifica contra la llave, así que no se lo puede DECLARAR.
    it('rechaza un anuncio cuyo id NO se deriva de su llave', () => {
        const other = makeNodeIdentity();
        const victima = makeNodeIdentity();
        const body = { v: 1, nodeId: victima.nodeId, pubkey: other.pubkey, url: 'https://p2', ts: Date.now(), nonce: newNonce() };
        const falso = { body, signature: signBody(other, body) };  // bien firmado, id ajeno
        expect(PeerRegistry.parseAnnouncement(falso, 'https://p2')).toBeNull();
    });

    it('rechaza un anuncio firmado por quien no es dueño de la pubkey', () => {
        const other = makeNodeIdentity();
        const impostor = makeNodeIdentity();
        const body = { v: 1, nodeId: other.nodeId, pubkey: other.pubkey, url: 'https://p2', ts: Date.now(), nonce: newNonce() };
        expect(PeerRegistry.parseAnnouncement({ body, signature: signBody(impostor, body) }, 'https://p2')).toBeNull();
    });

    it('rechaza anuncios viejos', () => {
        const other = makeNodeIdentity();
        const stale = { v: 1, nodeId: other.nodeId, pubkey: other.pubkey, url: 'https://p2', ts: Date.now() - 10 * 60 * 1000 };
        expect(PeerRegistry.parseAnnouncement({ body: stale, signature: signBody(other, stale) }, 'https://p2')).toBeNull();
    });

    it('NO cambia la pubkey pineada de un URL por su cuenta', () => {
        const legit = makeNodeIdentity();
        const rotada = makeNodeIdentity();
        registry.adopt({ url: 'https://p2', pubkey: legit.pubkey, nodeId: legit.nodeId });
        const r = registry.adopt({ url: 'https://p2', pubkey: rotada.pubkey, nodeId: rotada.nodeId });
        expect(r.status).toBe('conflict');
        expect(registry.byNodeId(legit.nodeId)).not.toBeNull();
        expect(registry.byNodeId(rotada.nodeId)).toBeNull();
    });

    it('rechaza el mismo nodo anunciado bajo dos URLs', () => {
        const other = makeNodeIdentity();
        registry.adopt({ url: 'https://a', pubkey: other.pubkey, nodeId: other.nodeId });
        const r = registry.adopt({ url: 'https://b', pubkey: other.pubkey, nodeId: other.nodeId });
        expect(r.status).toBe('conflict');
    });

    it('rechaza a un peer que anuncia MI propia llave', () => {
        const r = registry.adopt({ url: 'https://hostil', pubkey: self.pubkey, nodeId: self.nodeId });
        expect(r.status).toBe('conflict');
    });

    it('re-adoptar el mismo peer es idempotente', () => {
        const other = makeNodeIdentity();
        const peer = { url: 'https://p2', pubkey: other.pubkey, nodeId: other.nodeId };
        expect(registry.adopt(peer).status).toBe('pinned');
        expect(registry.adopt(peer).status).toBe('known');
        expect(registry.known()).toHaveLength(1);
    });

    // El filtro de 2 caracteres NO es exclusivo: dos nodos pueden compartirlo y
    // eso está bien. Lo que importa es que se devuelvan TODOS los candidatos,
    // para no elegir "el primero que conteste".
    it('candidatesByHint devuelve todos los que comparten filtro', () => {
        const a = makeNodeIdentity();
        const b = { ...makeNodeIdentity() };
        // Forzamos que compartan filtro para probar el caso, que es raro por azar.
        b.nodeId = a.nodeId.slice(0, CODE_HINT_LEN) + b.nodeId.slice(CODE_HINT_LEN);
        registry.adopt({ url: 'https://a', pubkey: a.pubkey, nodeId: a.nodeId });
        registry.adopt({ url: 'https://b', pubkey: b.pubkey, nodeId: b.nodeId });
        const cands = registry.candidatesByHint(a.nodeId.slice(0, CODE_HINT_LEN));
        expect(cands).toHaveLength(2);
        expect(registry.candidatesByHint('ZZ')).toHaveLength(0);
    });

    it('descarta al rehidratar los pineos cuyo id no deriva de su llave', () => {
        const other = makeNodeIdentity();
        registry.adopt({ url: 'https://p2', pubkey: other.pubkey, nodeId: other.nodeId });
        // Simula una fila del esquema viejo, donde el id se DECLARABA.
        persist.rows.get('https://p2').node_id = 'P1XXXXXXXXXX';
        const fresh = new PeerRegistry({ urls: [], identity: self, persist, log: () => {} });
        expect(fresh.load()).toBe(0);
        expect(persist.rows.size).toBe(0);
    });

    it('rehidrata los pineos válidos', () => {
        const other = makeNodeIdentity();
        registry.adopt({ url: 'https://p2', pubkey: other.pubkey, nodeId: other.nodeId });
        const fresh = new PeerRegistry({ urls: [], identity: self, persist, log: () => {} });
        expect(fresh.load()).toBe(1);
        expect(fresh.byNodeId(other.nodeId).pubkey).toBe(other.pubkey);
    });

    it('el anuncio propio va firmado y se verifica contra la propia llave', () => {
        const a = registry.selfAnnouncement('https://yo');
        expect(a.body.nodeId).toBe(self.nodeId);
        expect(verifyBody(a.body, a.signature, self.pubkey)).toBe(true);
        expect(PeerRegistry.parseAnnouncement(a, 'https://yo')).toMatchObject({ nodeId: self.nodeId });
    });
});
