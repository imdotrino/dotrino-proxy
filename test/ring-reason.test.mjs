/**
 * EL TIMBRE DEL NAVEGADOR DICE EL PORQUÉ (dueño, 2026-09-30). Si lo que se encola es el aviso
 * de la bóveda de un pedido de aprobación, el Web Push lleva qué se pide y quién —datos que
 * este proxio ya ve, cifrados hasta el navegador—. Y si es el aviso de que la bóveda se
 * actualizó (dueño, 2026-10-08), a qué versión y desde cuál. Lo que se fija: que se saque bien, que no
 * se invente nada para otros mensajes, y que no pase de lo necesario.
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
process.env.NODE_ENV = 'test'
const { _ringHint } = require('../server.js')

describe('ringHint', () => {
  it('saca qué se pide y quién del aviso de pedido de la bóveda', () => {
    const msg = JSON.stringify({ type: 'vault.admin.event', body: { ev: 'approval', id: 'x', ns: 'proxy', kind: 'read', deviceId: '904C-1002', label: 'proxy1', exp: 1 }, seal: {} })
    expect(_ringHint(msg)).toEqual({ why: { ev: 'approval', kind: 'read', ns: 'proxy', label: 'proxy1', deviceId: '904C-1002' } })
  })
  it('saca qué se actualizó, en qué aparato, a qué versión y desde cuál', () => {
    const msg = JSON.stringify({ type: 'vault.admin.event', body: { ev: 'updated', version: '0.30.0', from: '0.29.0', product: '@dotrino/terminal-agent', deviceId: '904C-1002', label: 'pc', ts: 1 } })
    expect(_ringHint(msg)).toEqual({ why: { ev: 'updated', version: '0.30.0', from: '0.29.0', product: '@dotrino/terminal-agent', label: 'pc', deviceId: '904C-1002' } })
    // La bóveda puede no decir aparato: lo que falta es null, no se inventa.
    expect(_ringHint({ type: 'vault.admin.event', body: { ev: 'updated', version: '0.147.0', from: '0.146.0' } }))
      .toEqual({ why: { ev: 'updated', version: '0.147.0', from: '0.146.0', product: null, label: null, deviceId: null } })
    // Recortado y sin nada más del cuerpo: es un aviso, no un canal.
    const r = _ringHint({ type: 'vault.admin.event', body: { ev: 'updated', version: 'v'.repeat(99), from: 7, product: 'p'.repeat(99), label: 'l'.repeat(99), deviceId: 'd'.repeat(99), extra: 'no' } })
    expect(r).toEqual({ why: { ev: 'updated', version: 'v'.repeat(20), from: null, product: 'p'.repeat(64), label: 'l'.repeat(64), deviceId: 'd'.repeat(16) } })
  })
  it('y si la actualización no se pudo instalar sola, lo dice con los mismos datos', () => {
    const body = { ev: 'update-needs-root', version: '0.147.0', from: '0.146.0', product: '@dotrino/vaultd', deviceId: 'AB12-CD34', label: 'vps', ts: 1 }
    expect(_ringHint({ type: 'vault.admin.event', body }))
      .toEqual({ why: { ev: 'update-needs-root', version: '0.147.0', from: '0.146.0', product: '@dotrino/vaultd', label: 'vps', deviceId: 'AB12-CD34' } })
    const r = _ringHint({ type: 'vault.admin.event', body: { ev: 'update-needs-root', version: 'v'.repeat(99), product: 'p'.repeat(99), extra: 'no' } })
    expect(r).toEqual({ why: { ev: 'update-needs-root', version: 'v'.repeat(20), from: null, product: 'p'.repeat(64), label: null, deviceId: null } })
  })
  it('no inventa nada para cualquier otro mensaje', () => {
    expect(_ringHint(JSON.stringify({ type: 'vault.admin.event', body: { ev: 'vars' } }))).toBe(null)
    expect(_ringHint(JSON.stringify({ op: 'hola' }))).toBe(null)
    expect(_ringHint('no es json')).toBe(null)
    expect(_ringHint(null)).toBe(null)
  })
  it('recorta lo que sea demasiado largo: es un aviso, no un canal', () => {
    const r = _ringHint({ type: 'vault.admin.event', body: { ev: 'approval', ns: 'x'.repeat(500), label: 'y'.repeat(500), kind: 'write' } })
    expect(r.why.ns.length).toBe(64)
    expect(r.why.label.length).toBe(64)
  })
  it('«delivered»: un aparato desatendido se llevó claves; dice qué cajón y quién', () => {
    const body = { ev: 'delivered', id: 'x', kind: 'passwords', ns: 'passwords', deviceId: 'AB12-CD34', label: 'servidor', ts: 1 }
    expect(_ringHint({ type: 'vault.admin.event', body }))
      .toEqual({ why: { ev: 'delivered', kind: 'passwords', ns: 'passwords', label: 'servidor', deviceId: 'AB12-CD34' } })
  })
  it('el asunto SELLADO pasa tal cual (también a FCM/APNs); malformado o grande, no pasa', () => {
    const ring = { wrap: { epk: 'a', iv: 'b', ct: 'c' }, envelope: { gen: 0, iv: 'd', ct: 'e' } }
    const body = { ev: 'approval', id: 'x', ns: 'proxy', kind: 'read', deviceId: '904C-1002', label: 'proxy1' }
    const r = _ringHint({ type: 'vault.admin.event', body, ring })
    expect(JSON.parse(r.sealed)).toEqual(ring)
    expect(r.why.ns).toBe('proxy')
    // Un aviso que el proxio no sabe contar, pero que trae asunto: va solo el asunto.
    expect(_ringHint({ type: 'vault.admin.event', body: { ev: 'otro' }, ring })).toEqual({ sealed: JSON.stringify(ring) })
    expect(_ringHint({ type: 'vault.admin.event', body, ring: { wrap: 'x', envelope: {} } }).sealed).toBeUndefined()
    expect(_ringHint({ type: 'vault.admin.event', body, ring: { wrap: { ct: 'x'.repeat(3000) }, envelope: {} } }).sealed).toBeUndefined()
    // Fuera de un aviso de la bóveda, nada.
    expect(_ringHint({ type: 'otro', ring })).toBe(null)
  })
})
