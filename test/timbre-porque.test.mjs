/**
 * EL TIMBRE DEL NAVEGADOR DICE EL PORQUÉ (dueño, 2026-09-30). Si lo que se encola es el aviso
 * de la bóveda de un pedido de aprobación, el Web Push lleva qué se pide y quién —datos que
 * este proxio ya ve, cifrados hasta el navegador—. Lo que se fija: que se saque bien, que no
 * se invente nada para otros mensajes, y que no pase de lo necesario.
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
process.env.NODE_ENV = 'test'
const { _approvalHint } = require('../server.js')

describe('approvalHint', () => {
  it('saca qué se pide y quién del aviso de pedido de la bóveda', () => {
    const msg = JSON.stringify({ type: 'vault.admin.event', body: { ev: 'approval', id: 'x', ns: 'proxy', kind: 'read', deviceId: '904C-1002', label: 'proxy1', exp: 1 }, seal: {} })
    expect(_approvalHint(msg)).toEqual({ why: { ev: 'approval', kind: 'read', ns: 'proxy', label: 'proxy1', deviceId: '904C-1002' } })
  })
  it('no inventa nada para cualquier otro mensaje', () => {
    expect(_approvalHint(JSON.stringify({ type: 'vault.admin.event', body: { ev: 'vars' } }))).toBe(null)
    expect(_approvalHint(JSON.stringify({ op: 'hola' }))).toBe(null)
    expect(_approvalHint('no es json')).toBe(null)
    expect(_approvalHint(null)).toBe(null)
  })
  it('recorta lo que sea demasiado largo: es un aviso, no un canal', () => {
    const r = _approvalHint({ type: 'vault.admin.event', body: { ev: 'approval', ns: 'x'.repeat(500), label: 'y'.repeat(500), kind: 'write' } })
    expect(r.why.ns.length).toBe(64)
    expect(r.why.label.length).toBe(64)
  })
})
