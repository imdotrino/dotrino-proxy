import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
    startTestServer,
    stopTestServer,
    connectClient
} from './helpers.mjs';

// Endurecimiento previo a volver GLOBAL el espacio de nombres de tokens: mientras
// el token solo valía dentro de un proxy, adivinarlo o abanicar un mensaje costaba
// poco daño. Con federación, cada destino de un frame se convierte en tráfico
// hacia los peers, así que el coste de un frame tiene que estar acotado por diseño.
describe('endurecimiento: tope de fan-out y de tamaño de frame', () => {
    let url;
    const clients = [];

    beforeAll(async () => {
        ({ url } = await startTestServer());
    });

    afterAll(async () => {
        await stopTestServer();
    });

    afterEach(async () => {
        while (clients.length) {
            const c = clients.pop();
            try { await c.close(); } catch (_) { /* noop */ }
        }
    });

    async function connect() {
        const c = await connectClient(url);
        clients.push(c);
        return c;
    }

    describe('fan-out por mensaje', () => {
        it('acepta un mensaje con destinos dentro del tope', async () => {
            const a = await connect();
            const b = await connect();
            a.send({ to: [b.token], message: 'hola' });
            const got = await b.waitFor((m) => m.type === 'message');
            expect(got.message).toBe('hola');
        });

        it('rechaza un mensaje con más destinos que el tope', async () => {
            const a = await connect();
            // 65 destinos inventados: el tope por defecto es 64.
            const many = Array.from({ length: 65 }, (_, i) => `T${String(i).padStart(3, '0')}`);
            a.send({ to: many, message: 'spam', id: 'fanout-1' });
            const err = await a.waitFor((m) => m.type === 'error');
            expect(err.error).toMatch(/destinatarios/i);
            expect(err.id).toBe('fanout-1');
        });

        it('cuenta juntos los destinos por token y por publickey', async () => {
            const a = await connect();
            const tokens = Array.from({ length: 40 }, (_, i) => `T${String(i).padStart(3, '0')}`);
            const pubkeys = Array.from({ length: 40 }, (_, i) => `pk-${i}`);
            a.send({ to: tokens, to_publickey: pubkeys, message: 'spam' });
            const err = await a.waitFor((m) => m.type === 'error');
            expect(err.error).toMatch(/destinatarios/i);
        });

        it('no rechaza el caso normal de un solo destino por publickey', async () => {
            const a = await connect();
            a.send({ to_publickey: 'pk-desconocida', message: 'hola', id: 'pk-1' });
            const res = await a.waitFor((m) => m.type === 'message_sent' || m.type === 'error');
            expect(res.type).toBe('message_sent');
        });
    });

    describe('tamaño de frame', () => {
        it('corta la conexión ante un frame mayor que maxPayload', async () => {
            const a = await connect();
            const closed = new Promise((resolve) => a.ws.once('close', (code) => resolve(code)));
            // 2 MB de payload contra un tope de 1 MB.
            a.send({ to: ['ABCD'], message: 'x'.repeat(2 * 1024 * 1024) });
            const code = await closed;
            // `ws` cierra con 1009 (Message Too Big) al exceder maxPayload.
            expect(code).toBe(1009);
        });
    });
});
