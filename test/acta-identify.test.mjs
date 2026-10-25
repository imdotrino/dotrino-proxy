/**
 * EL ACTA AL IDENTIFICARSE: atar el token también al `profileId` de la persona.
 *
 * Esto no tenía ni una prueba, y por eso llevaba versiones muerto: `verifyActaMembership`
 * exigía `v === 1` y el campo `sealer`, y los dos desaparecieron —el acta va por la v5 y
 * sellar pasó a ser un PERMISO—. O sea que devolvía `null` para toda acta real y el proxio
 * no ataba el perfil de nadie. No se notó porque la bóveda se identificaba con la maestra,
 * que entra por otra puerta; y es justo lo que se quiere dejar de hacer, para que la
 * maestra pueda vivir bajo llave.
 */
import { describe, it, expect } from 'vitest'
import { verifyActaMembership } from './server.js'
import { makeDeviceKey, signWithDevice } from '@dotrino/identity/capabilities'
import { actaBody } from '@dotrino/identity/acta'

/**
 * Un acta a mano, firmada como la firma el pilar (`signWithDevice` sobre `actaBody`).
 *
 * NO se usa `sealActa`: valida antes de firmar y se niega a producir las actas TORCIDAS
 * que hacen falta aquí —una que se autonombra perfil sin permiso de sellar, otra sin quien
 * firme—. Y esas son exactamente las que tiene que rechazar el proxio: quien ataca no pasa
 * por nuestro validador.
 */
async function acta ({ sealerKey, memberList, renounced = [], v = 5, signer = null }) {
  const body = {
    v,
    profileId: sealerKey.publickey,
    sealedBy: sealerKey.publickey,
    seq: 1,
    members: memberList,
    renounced,
    keyring: [],
    sealPub: null,
    sealSince: 0,
    sealKeys: [],
    updatedAt: Date.now()
  }
  const who = signer || sealerKey
  const { signature } = await signWithDevice({ privateJwk: who.privateJwk, publickey: body.sealedBy, data: actaBody(body) })
  return { ...body, sig: signature }
}

describe('verifyActaMembership', () => {
  it('un acta v5 vale, y ata el perfil del miembro que habla', async () => {
    const master = await makeDeviceKey()
    const phone = await makeDeviceKey()
    const a = await acta({
      sealerKey: master,
      memberList: [
        { pub: master.publickey, caps: ['sign', 'read', 'store', 'sealer'] },
        { pub: phone.publickey, caps: ['sign', 'read'] }
      ]
    })
    // Lo que importa: habla el TELÉFONO, que no sella nada, y aun así el proxio le ata el
    // perfil. Eso es lo que deja que la bóveda hable con una llave que no es la maestra.
    expect(verifyActaMembership(a, phone.publickey)).toBe(master.publickey)
    expect(verifyActaMembership(a, master.publickey)).toBe(master.publickey)
  })

  it('se leen las versiones que existen, no una del futuro', async () => {
    const master = await makeDeviceKey()
    const memberList = [{ pub: master.publickey, caps: ['sign', 'sealer'] }]
    for (const v of [3, 4, 5]) {
      const a = await acta({ sealerKey: master, memberList, v })
      expect(verifyActaMembership(a, master.publickey), `v${v}`).toBe(master.publickey)
    }
    // Una v6 se rechaza en vez de intentar leerla a ciegas: el proxio no sabe qué campos
    // trae ni qué significan, y adivinar es peor que decir que no.
    const future = await acta({ sealerKey: master, memberList, v: 6 })
    expect(verifyActaMembership(future, master.publickey)).toBe(null)
  })

  it('NO se puede secuestrar el perfil de otro fabricando un acta', async () => {
    const victim = await makeDeviceKey()
    const attacker = await makeDeviceKey()
    // El acta dice el perfil de la víctima; la sella el atacante, que se nombra sellador a
    // sí mismo. La firma cuadra —la hizo él—, el permiso cuadra —se lo puso él— y aun así
    // no vale: quien selló no es la llave que da nombre al perfil.
    const forged = await acta({
      sealerKey: attacker,
      memberList: [{ pub: attacker.publickey, caps: ['sign', 'sealer'] }]
    })
    forged.profileId = victim.publickey
    const resigned = await acta({
      sealerKey: attacker,
      memberList: [{ pub: attacker.publickey, caps: ['sign', 'sealer'] }]
    })
    // Bien firmada de arriba abajo, solo que con el `profileId` de la víctima dentro.
    const body = { ...resigned, profileId: victim.publickey }
    const { signature } = await signWithDevice({
      privateJwk: attacker.privateJwk, publickey: attacker.publickey, data: actaBody(body)
    })
    const wellSigned = { ...body, sig: signature }

    expect(verifyActaMembership(forged, attacker.publickey)).toBe(null)
    expect(verifyActaMembership(wellSigned, attacker.publickey)).toBe(null)
    // Y para que quede claro que no es la firma lo que lo salva: con SU propio perfil sí.
    expect(verifyActaMembership(resigned, attacker.publickey)).toBe(attacker.publickey)
  })

  it('quien la selló TIENE que poder sellar, o no vale', async () => {
    const master = await makeDeviceKey()
    const phone = await makeDeviceKey()
    // El teléfono se fabrica un acta donde él es el perfil… pero se nombra sin `sealer`.
    // La firma cuadra (la hizo él); lo que no cuadra es la autoridad.
    const theirs = await acta({
      sealerKey: phone,
      memberList: [{ pub: phone.publickey, caps: ['sign', 'read'] }]
    })
    expect(verifyActaMembership(theirs, phone.publickey)).toBe(null)
  })

  it('una firma que no es de quien dice no vale', async () => {
    const master = await makeDeviceKey()
    const other = await makeDeviceKey()
    const a = await acta({ sealerKey: master, memberList: [{ pub: master.publickey, caps: ['sealer'] }] })
    // Firmada por OTRO, diciendo que la firmó el master.
    const impersonated = await acta({ sealerKey: master, memberList: [{ pub: master.publickey, caps: ['sealer'] }], signer: other })
    expect(verifyActaMembership(impersonated, master.publickey)).toBe(null)
    // Y tocarle un campo después de firmada tampoco cuela.
    expect(verifyActaMembership({ ...a, seq: 99 }, master.publickey)).toBe(null)
  })

  it('quien no es miembro no ata nada', async () => {
    const master = await makeDeviceKey()
    const stranger = await makeDeviceKey()
    const a = await acta({ sealerKey: master, memberList: [{ pub: master.publickey, caps: ['sealer'] }] })
    expect(verifyActaMembership(a, stranger.publickey)).toBe(null)
  })

  it('una renuncia al permiso de sellar se resta', async () => {
    const master = await makeDeviceKey()
    const a = await acta({
      sealerKey: master,
      memberList: [{ pub: master.publickey, caps: ['sign', 'sealer'] }],
      renounced: [{ member: master.publickey, caps: ['sealer'] }]
    })
    expect(verifyActaMembership(a, master.publickey)).toBe(null)
  })

  it('basura no revienta', () => {
    for (const x of [null, undefined, 'texto', {}, { v: 5 }, { v: 5, members: 'no' }]) {
      expect(verifyActaMembership(x, 'pub')).toBe(null)
    }
  })
})

/**
 * LA SEGUNDA BÓVEDA (multivault, `Mode: join` en Lambda). Sella con su llave, no con la del
 * perfil, y lo que la ata al perfil es el eslabón que el acta lleva dentro. Las actas salen
 * del pilar de verdad (`applyChanges` + `sealActa`): si el proxio y el pilar dejan de decir
 * lo mismo sobre el eslabón, esto se rompe.
 *
 * El caso que lo trajo (2026-10-25): la bóveda en Lambda de Seyacat selló el acta #56, y el
 * proxio dejó de atar el perfil a todo aparato que se identificara con ella, y no le dejó
 * registrar su timbre (`not-a-member`).
 */
describe('verifyActaMembership: una segunda bóveda que sella', () => {
  async function account () {
    const { genesisActa, applyChanges, sealActa } = await import('@dotrino/identity/acta')
    const seal = (a, k) => sealActa({ acta: a, privateJwk: k.privateJwk })
    const A = await makeDeviceKey()   // la llave del perfil
    const B = await makeDeviceKey()   // la segunda bóveda
    const phone = await makeDeviceKey()
    let acta = await seal(genesisActa({ pub: A.publickey, label: 'A' }), A)
    acta = await seal(await applyChanges(acta, [
      { op: 'admit', member: { pub: B.publickey, label: 'B', caps: ['sign', 'read', 'store', 'sealer'] } },
      { op: 'admit', member: { pub: phone.publickey, label: 'tel', caps: ['sign'] } }
    ], { by: A.publickey }), A)
    const byB = await seal(await applyChanges(acta, [{ op: 'label', pub: phone.publickey, label: 'Teléfono' }], { by: B.publickey }), B)
    return { A, B, phone, admitted: acta, byB, applyChanges, seal }
  }

  it('un acta sellada por la segunda bóveda ata el perfil', async () => {
    const { A, B, phone, byB } = await account()
    expect(byB.sealedBy).toBe(B.publickey)
    expect(verifyActaMembership(byB, phone.publickey)).toBe(A.publickey)
    expect(verifyActaMembership(byB, B.publickey)).toBe(A.publickey)
  })

  it('un eslabón tocado no vale', async () => {
    const { phone, byB } = await account()
    // Cambiar el eslabón rompe también la firma del acta; aquí se mira la del eslabón sola.
    const link = { ...byB.sealerLink, sig: byB.sealerLink.sig.slice(0, -4) + 'AAAA' }
    expect(verifyActaMembership({ ...byB, sealerLink: link }, phone.publickey)).toBe(null)
  })

  it('NO se secuestra un perfil con un eslabón suyo y una llave ajena', async () => {
    const { A, phone, byB } = await account()
    const attacker = await makeDeviceKey()
    // El atacante tiene un eslabón auténtico de la víctima (son públicos) y se fabrica un
    // acta con él, nombrándose sellador. El eslabón no lo nombra: no vale.
    const body = {
      ...byB, sealedBy: attacker.publickey,
      members: [...byB.members, { pub: attacker.publickey, caps: ['sign', 'sealer'] }]
    }
    delete body.sig
    const { signature } = await signWithDevice({ privateJwk: attacker.privateJwk, publickey: attacker.publickey, data: actaBody(body) })
    expect(verifyActaMembership({ ...body, sig: signature }, attacker.publickey)).toBe(null)
    expect(verifyActaMembership({ ...body, sig: signature }, phone.publickey)).toBe(null)
    expect(A.publickey).not.toBe(attacker.publickey)
  })

  it('un eslabón firmado por otra selladora (dos saltos) no se acepta', async () => {
    const { B, phone, byB, applyChanges, seal } = await account()
    const C = await makeDeviceKey()
    // B nombra a C selladora: el eslabón nuevo lo firma B, no la llave del perfil.
    let acta = await seal(await applyChanges(byB, [{ op: 'admit', member: { pub: C.publickey, label: 'C', caps: ['sign', 'sealer'] } }], { by: B.publickey }), B)
    expect(acta.sealerLink.by).toBe(B.publickey)
    expect(verifyActaMembership(acta, phone.publickey)).toBe(null)
  })
})
