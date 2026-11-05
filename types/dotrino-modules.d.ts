// Subpaths de los pilares que no traen declaraciones de tipos en las versiones que usa el
// proxio (@dotrino/vault 0.90.3, @dotrino/update 0.9.0, @dotrino/identity 0.120.0 en
// `./capabilities`). Se declara SOLO lo que usa este repo, con la forma del código del pilar.

declare module '@dotrino/vault/service' {
  /** Lo que guarda el enrolamiento de un servicio (`service-identity.json`). */
  export interface ServiceIdentityRecord {
    device?: { publickey?: string, privateJwk?: import('node:crypto').JsonWebKey }
    iss?: unknown
    [key: string]: unknown
  }
  export function enrollService(opts: {
    qr: string
    ns: string
    dir: string
    onReplace?: (prev: { deviceId: string, enrolledAt: number }) => void
    onCode?: (info: { deviceId: string, code: string }) => void
  }): Promise<unknown>
  export function readServiceIdentity(dir: string): ServiceIdentityRecord | null
  export function waitForSecrets(opts: {
    dir: string
    ns: string
    onRetry?: (e: Error, delayMs: number) => void
  }): Promise<Record<string, string>>
}

declare module '@dotrino/vault/env' {
  export function applyEnv(secrets: Record<string, string>): { injected: string[], overridden: string[] }
  export function watchEnv(opts: {
    ns: string
    dir: string
    log?: (msg: unknown) => void
    applied?: Record<string, string>
    onUpdate: (info: { ns: string, ts: number, reason: 'changed' | 'revoked', via?: 'notice' | 'reconcile' }) => void
  }): Promise<{ stop(): void } | null>
}

declare module '@dotrino/update' {
  export function watchForUpdate(opts: {
    current: string
    source: 'npm' | string
    pkg: string
    onNewer: (r: { version: string, current: string }) => void
  }): unknown
}

declare module '@dotrino/identity/capabilities' {
  export function pubkeyId(publickey: unknown): Promise<string>
}
