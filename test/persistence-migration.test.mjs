import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

// REGRESIÓN: `init()` tiraba el proceso al arrancar contra una base EXISTENTE.
// La suite solo abría bases nuevas (`:memory:`), así que ningún test tocaba el
// camino de migración — y el arranque contra el disco de producción reventaba
// con "no such column: node_id" y dejaba los dos nodos en 502.
describe('migración del esquema de peer_nodes', () => {
    const files = [];
    const tmpDb = () => {
        const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dotrino-mig-')), 'proxy.db');
        files.push(f);
        return f;
    };

    afterEach(() => {
        while (files.length) {
            const f = files.pop();
            try { fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch (_) {}
        }
    });

    const freshPersist = () => {
        // `persistence.js` guarda la conexión en módulo: hay que recargarlo para
        // abrir otra base en el mismo proceso.
        delete require.cache[require.resolve('../persistence.js')];
        return require('../persistence.js');
    };

    it('arranca sobre una base con el esquema VIEJO (columna prefix)', () => {
        const file = tmpDb();
        // Base tal como la dejó la versión anterior.
        const db = new DatabaseSync(file);
        db.exec(`
            CREATE TABLE peer_nodes (
                url        TEXT PRIMARY KEY,
                pubkey     TEXT NOT NULL,
                prefix     TEXT NOT NULL,
                pinned_at  INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX idx_peer_prefix ON peer_nodes(prefix);
        `);
        db.prepare('INSERT INTO peer_nodes VALUES (?,?,?,?,?)')
            .run('https://viejo', 'pk-vieja', 'P2', Date.now(), Date.now());
        db.close();

        const persist = freshPersist();
        expect(() => persist.init(file)).not.toThrow();

        // La tabla vieja se descarta entera: un id DECLARADO no se puede seguir
        // creyendo ahora que se deriva de la llave.
        expect(persist.loadPeerNodes()).toEqual([]);

        // Y la nueva funciona.
        persist.pinPeerNode('https://p2', 'pk-nueva', '3PQ2QE8ZMD8J', Date.now());
        expect(persist.loadPeerNodes()).toHaveLength(1);
        expect(persist.loadPeerNodes()[0].node_id).toBe('3PQ2QE8ZMD8J');
    });

    it('arranca sobre una base NUEVA', () => {
        const persist = freshPersist();
        expect(() => persist.init(tmpDb())).not.toThrow();
        expect(persist.loadPeerNodes()).toEqual([]);
    });

    it('arranca DOS VECES sobre la misma base (idempotente)', () => {
        const file = tmpDb();
        let persist = freshPersist();
        persist.init(file);
        persist.pinPeerNode('https://p2', 'pk', '3PQ2QE8ZMD8J', Date.now());

        persist = freshPersist();
        expect(() => persist.init(file)).not.toThrow();
        expect(persist.loadPeerNodes()).toHaveLength(1);
    });

    it('no deja que dos URLs pineen el mismo id de nodo', () => {
        const persist = freshPersist();
        persist.init(tmpDb());
        persist.pinPeerNode('https://a', 'pk', '3PQ2QE8ZMD8J', Date.now());
        expect(() => persist.pinPeerNode('https://b', 'pk', '3PQ2QE8ZMD8J', Date.now())).toThrow();
    });
});
