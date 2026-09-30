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
const ESPAÑOL = /[áéíóúñ¿¡]|\b(inválid[oa]|código|nodo|canal|firma|formato|destinatarios?|pareados|caducado|sin|desconocid[oa]|habilitad[oa]|deshabilitad[oa]|enviando|timbre|recibid[oa]|cliente|conectad[oa]|desde|para|cola|llave|mensaje|esperando|reintento)\b/i

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

/**
 * Y LOS LOGS TAMBIÉN (§8.1): son lo que se pega en un issue y lo que se busca. `enroll-vault.js`
 * queda fuera a propósito: es un comando interactivo y lo que imprime es copia para quien lo
 * usa, que puede ir en español.
 */
describe('logs del proxio', () => {
  const archivos = ['server.js', 'mesh.js', 'peers.js', 'tokenManager.js', 'vaultSecrets.js', 'nodeIdentity.js',
    'persistence.js', 'apns.js', 'fcm.js', 'turnCredentials.js', 'pairingCodes.js']
  for (const archivo of archivos) {
    it(`${archivo}: ningún log en español`, () => {
      const fuente = fs.readFileSync(path.join(raiz, archivo), 'utf8')
      const llamadas = [...fuente.matchAll(/(?:console\.(?:log|warn|error|info)|\blog|this\.log)\(\s*([`'"])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2])
      expect(llamadas.filter((t) => ESPAÑOL.test(t))).toEqual([])
    })
  }
})
