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
