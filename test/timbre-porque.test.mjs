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
  it('saca a qué versión se actualizó la bóveda, y desde cuál', () => {
    const msg = JSON.stringify({ type: 'vault.admin.event', body: { ev: 'updated', version: '0.147.0', from: '0.146.0', ts: 1 } })
    expect(_ringHint(msg)).toEqual({ why: { ev: 'updated', version: '0.147.0', from: '0.146.0' } })
    // Recortado y sin nada más del cuerpo: es un aviso, no un canal.
    const r = _ringHint({ type: 'vault.admin.event', body: { ev: 'updated', version: 'v'.repeat(99), from: 7, extra: 'no' } })
    expect(r).toEqual({ why: { ev: 'updated', version: 'v'.repeat(20), from: null } })
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
})
