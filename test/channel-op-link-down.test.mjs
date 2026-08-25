// Una operación de canal cuyo dueño está incomunicado tiene que fallar YA, no a los 6 s.
//
// `forwardChannelOp` manda el `chan-op` con `retain:false` —tráfico efímero, no se guarda
// para después— pero `mesh.sendTo` solo miraba si EXISTÍA el enlace, no si estaba listo.
// Durante la ventana de reconexión del peer se daba por enviado algo que no salía de la
// máquina, y el cliente esperaba el timeout completo antes de un «no respondió», cuando
// aquí ya se sabía que no había por dónde. Le pasó al content node al reiniciarse el
// proxio: se quedaba sin anunciar en el otro proxio con un timeout en vez de un error
// accionable.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { startNode, makeNodeDir, connectTo, freePort } from './fedHelpers.mjs';

const require = createRequire(import.meta.url);
const crypto = require('crypto');

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

describe('canal cuyo dueño se quedó sin enlace', () => {
    let a, b, dirA, dirB, bNodeId;

    beforeAll(async () => {
        dirA = makeNodeDir('down-a');
        dirB = makeNodeDir('down-b');
        const portA = await freePort();
        const portB = await freePort();
        [a, b] = await Promise.all([
            startNode({ name: 'A', dir: dirA, port: portA, peers: [`http://127.0.0.1:${portB}`] }),
            startNode({ name: 'B', dir: dirB, port: portB, peers: [`http://127.0.0.1:${portA}`] })
        ]);
        bNodeId = b.nodeId;
    }, 60000);

    afterAll(async () => { await a?.stop?.(); await b?.stop?.(); });

    it('falla enseguida en vez de esperar el timeout del dueño', async () => {
        // B se cae: A conserva el peer (lo tiene configurado) pero el enlace deja de estar listo.
        await b.stop();

        const cliente = await connectTo(a.url);
        const sign = makeChannelSigner();
        const t0 = Date.now();
        cliente.send({ type: 'publish', channel: sign(`${bNodeId}/content_prueba`), id: 'p1' });
        const res = await cliente.waitFor((m) => (m.type === 'error' || m.type === 'published') && m.id === 'p1', 12000);
        const tardo = Date.now() - t0;

        expect(res.type).toBe('error');
        // El timeout del dueño son 6 s: si tardó eso, es que se creyó enviado.
        expect(tardo).toBeLessThan(3000);
        await cliente.close();
    }, 40000);
});
