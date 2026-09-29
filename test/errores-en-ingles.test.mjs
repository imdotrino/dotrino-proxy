/**
 * LAS RESPUESTAS DEL PROXIO VAN EN INGLÉS Y CON `code` (CONVENCIONES §8.1). Estaban en
 * español y sin código, así que un cliente solo podía distinguirlas por la frase — y las
 * pruebas de aquí hacían exactamente eso. Esta suite lee el código fuente: un `error:` con
 * texto en español en una respuesta vuelve a romper la convención y aquí se ve.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ESPAÑOL = /[áéíóúñ¿¡]|\b(inválid[oa]|código|nodo|canal|firma|formato|destinatarios?|pareados|caducado|sin|desconocid[oa])\b/i

describe('respuestas del proxio', () => {
  for (const archivo of ['server.js', 'pairingCodes.js']) {
    it(`${archivo}: ningún error de respuesta en español`, () => {
      const fuente = fs.readFileSync(path.join(raiz, archivo), 'utf8')
      const errores = [...fuente.matchAll(/\berror:\s*([`'"])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2])
      expect(errores.length).toBeGreaterThan(0)
      expect(errores.filter((t) => ESPAÑOL.test(t))).toEqual([])
    })
  }
})
