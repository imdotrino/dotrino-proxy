/**
 * LAS ÚLTIMAS ACTAS DE CADA CUENTA, EN EL PROXIO (dueño, 2026-11-04).
 *
 * Una caché para que un aparato sepa si su acta va atrás sin despertar a la bóveda. Lo que se
 * prueba es lo que hace que no sea un agujero: solo entra un acta sellada por su cuenta, se
 * guardan pocas, y quien pregunta recibe el acta entera para comprobarla él.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'module'
import { makeDeviceKey, signWithDevice } from '@dotrino/identity/capabilities'
import { actaBody } from '@dotrino/identity/acta'
import { startTestServer, stopTestServer, connectClient } from './helpers.mjs'

const require = createRequire(import.meta.url)
const { ActaCache } = require('../actaCache')

async function acta ({ key, seq = 1, sealedBy = null, signer = null, extra = {} }) {
  const body = {
    v: 5, profileId: key.publickey, sealedBy: sealedBy || key.publickey, seq,
    members: [{ pub: key.publickey, caps: ['sign', 'sealer'] }],
    renounced: [], keyring: [], sealPub: null, sealSince: 0, sealKeys: [], updatedAt: Date.now(), ...extra
  }
  const who = signer || key
  const { signature } = await signWithDevice({ privateJwk: who.privateJwk, publickey: body.sealedBy, data: actaBody(body) })
  return { ...body, sig: signature }
}

describe('ActaCache', () => {
  const fake = (seq, sig = `s${seq}`) => ({ seq, sig })

  it('se queda con las de seq más alto, y no repite', () => {
    const c = new ActaCache({ perProfile: 3 })
    for (const s of [1, 5, 3, 4, 2]) c.put('P', fake(s))
    expect(c.get('P').map((a) => a.seq)).toEqual([5, 4, 3])
    expect(c.put('P', fake(5))).toBe(false)
    expect(c.put('P', fake(1))).toBe(false)
    expect(c.get('P', 3).map((a) => a.seq)).toEqual([5, 4])
    expect(c.get('otra')).toEqual([])
  })

  it('dos actas distintas con el mismo seq caben (dos bóvedas)', () => {
    const c = new ActaCache({ perProfile: 3 })
    c.put('P', fake(7, 'a')); c.put('P', fake(7, 'b'))
    expect(c.get('P').map((a) => a.sig).sort()).toEqual(['a', 'b'])
  })

  it('topes: el peso de un acta y el número de cuentas', () => {
    const c = new ActaCache({ maxBytes: 100, maxProfiles: 2 })
    expect(c.put('P', { seq: 1, sig: 'x', pad: 'y'.repeat(200) })).toBe(false)
    c.put('A', fake(1)); c.put('B', fake(1)); c.get('A'); c.put('C', fake(1))
    expect(c.size).toBe(2)
    expect(c.get('B')).toEqual([])           // la que más tiempo llevaba sin tocarse
    expect(c.get('A').length).toBe(1)
  })
})

describe('acta-put / acta-get', () => {
  let server
  beforeAll(async () => { server = await startTestServer() })
  afterAll(async () => { await stopTestServer() })

  it('un acta sellada por su cuenta se guarda y se devuelve entera', async () => {
    const owner = await makeDeviceKey()
    const a1 = await acta({ key: owner, seq: 1 }); const a2 = await acta({ key: owner, seq: 2 })
    const c = await connectClient(server.url)
    c.send({ type: 'acta-put', acta: a2, id: 'p2' })
    expect(await c.waitFor((m) => m.id === 'p2')).toMatchObject({ type: 'acta-put', stored: true, seq: 2 })
    c.send({ type: 'acta-put', acta: a1, id: 'p1' })
    await c.waitFor((m) => m.id === 'p1')
    c.send({ type: 'acta-get', profileId: owner.publickey, sinceSeq: 1, id: 'g' })
    const got = await c.waitFor((m) => m.id === 'g')
    expect(got.type).toBe('acta-get')
    expect(got.actas).toEqual([a2])
    await c.close()
  })

  it('un acta que no selló su cuenta no entra', async () => {
    const victim = await makeDeviceKey(); const attacker = await makeDeviceKey()
    // Dice ser de la víctima y la firma el atacante.
    const forged = await acta({ key: victim, sealedBy: attacker.publickey, signer: attacker, extra: { members: [{ pub: attacker.publickey, caps: ['sign', 'sealer'] }] } })
    const c = await connectClient(server.url)
    c.send({ type: 'acta-put', acta: forged, id: 'f' })
    expect(await c.waitFor((m) => m.id === 'f')).toMatchObject({ type: 'error', code: 'bad-acta' })
    c.send({ type: 'acta-get', profileId: victim.publickey, id: 'g' })
    expect((await c.waitFor((m) => m.id === 'g')).actas).toEqual([])
    await c.close()
  })

  it('sin profileId se dice', async () => {
    const c = await connectClient(server.url)
    c.send({ type: 'acta-get', id: 'x' })
    expect(await c.waitFor((m) => m.id === 'x')).toMatchObject({ type: 'error', code: 'bad-input' })
    await c.close()
  })
})
