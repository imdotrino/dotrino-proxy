// Formas de datos que comparten los módulos del proxio.

/** Aviso del tope diario del TURN (`turnUsage.js` → `alerts.js`). */
export type TurnUsageEvent =
  | { kind: 'turn-daily-cap', day: string, egressBytes: number, capBytes: number }
  | { kind: 'turn-usage-unknown', error: string, capBytes: number }

/** Opciones de `createTurnUsage` (por defecto salen de `process.env`). */
export interface TurnUsageOptions {
  accountId?: string
  apiToken?: string
  keyId?: string
  dailyGb?: number | string
  pollSeconds?: number | string
  staleMs?: number
  fetchTimeoutMs?: number
  api?: string
  fetchImpl?: typeof fetch | null
  onAlert?: (ev: TurnUsageEvent) => void
  now?: () => number
}

/** Suscripción a APNs de un teléfono iOS. */
export interface ApnsSubscription { kind: 'apns', token: string, topic: string, env: 'sandbox' | 'production' }

/** Resultado de tocar un timbre (FCM, APNs). */
export interface RingResult { ok: boolean, disabled?: boolean, gone?: boolean, status?: number, body?: string }

/** Identidad de red de ESTE nodo (sale del enrolamiento a la bóveda). */
export interface NodeIdentity {
  /** JWK público serializado (string), como en `identify`. */
  pubkey: string
  privateJwk: import('node:crypto').JsonWebKey
  /** 12 caracteres, derivado de la llave. */
  nodeId: string
  /** Los 2 primeros caracteres del id: filtro del código corto. */
  hint: string
  /** La cuenta a la que se enroló (quien firmó su cert). */
  iss: string | null
}

/** Un servidor ICE (RTCIceServer) tal como se reparte al cliente. */
export interface IceServer { urls: string | string[], username?: string, credential?: string }

/** Lo que devuelve `issue` del emisor de TURN. */
export type TurnIssueResult =
  | { iceServers: IceServer[], expiresAt: number, ttl: number, limited?: undefined }
  | { limited: true, reason: 'turn-quota' | 'turn-daily-cap' | 'turn-usage-unknown', retry_after_ms: number }

/** Un mensaje en la cola offline de una pubkey (24 h). */
export interface QueuedItem {
  /** id de la fila en SQLite (una vez guardado). */
  id?: number
  /** token de quien lo mandó */
  from: string | null
  fromPubkey: string | null
  /** el cuerpo; falta si vive en el content node (`cid`) */
  message?: unknown
  cid?: string
  queuedAt: number
  expiresAt: number
  bytes: number
  app: string | null
}

/** Fila de `scheduled_pushes`. */
export interface ScheduledPushRow {
  id: number
  pubkey: string
  app: string | null
  payload: string | null
  next_fire: number
  cron: string | null
  tz: string | null
  created_at: number
  updated_at: number
}

/** Fila de `peer_nodes`: un nodo federado, pineado por su llave. */
export interface PeerNodeRow { url: string, pubkey: string, node_id: string, pinned_at: number, updated_at: number }

/** Fila de `enc_pubkeys`: el anuncio firmado de la llave de cifrado de una identidad. */
export interface EncPubRow { pubkey: string, data: string, signature: string, ts: number }

/** Un nodo federado conocido (pineado por su llave). */
export interface Peer { url: string, pubkey: string, nodeId: string }

/** Anuncio autofirmado de un nodo (`GET /node`). */
export interface NodeAnnouncement {
  body: { v: 1, nodeId: string, pubkey: string, url: string | null, ts: number, nonce: string }
  signature: string
}

/** Resultado de incorporar o descubrir un peer. */
export type AdoptResult =
  | { status: 'pinned' | 'known', peer: Peer }
  | { status: 'conflict' | 'unreachable', reason: string }

/** Un tramo de cubeta: ráfaga y ritmo sostenido. */
export interface Limit { burst: number, ratePerSec: number }

/** Lo que decide el limitador para un mensaje. */
export type RateDecision =
  | { status: 'ok' }
  | { status: 'soft_limit' | 'hard_limit', retry_after_ms: number, limit_type: 'ip_ban' | 'global' | 'per_type' }

/** El limitador (o su versión apagada). */
export interface RateLimiter {
  consume (token: string | null | undefined, ip: string | null | undefined, type: string): RateDecision
  releaseToken (token: string): void
  banIp (ip: string | null | undefined, ms?: number): void
  isIpBanned (ip: string | null | undefined): boolean
  banRemainingMs (ip: string | null | undefined): number
  unbanIp (ip: string): void
  destroy (): void
  _stats (): object
  banMs: number
}

/** Una trama de la malla entre nodos (JSON, o binaria con el mensaje en bytes). */
export interface MeshFrame {
  t: 'challenge' | 'hello' | 'ready' | 'ack' | 'msg' | 'bye' | string
  seq?: number
  op?: string
  /** Lo que lleva la operación: JSON de otro nodo, lo validan los manejadores. */
  payload?: any
  nonce?: string
  nodeId?: string
  body?: any
  signature?: string
  reason?: string
}

/** WebSocket de la malla, con lo que el proxio le cuelga. */
export type MeshSocket = import('ws').WebSocket & { isAlive?: boolean, meshPeer?: Peer }

/** Por dónde contestar a una operación de la malla: el enlace saliente o el socket entrante. */
export interface MeshReplyChannel { send (op: string, payload: unknown, opts?: { retain?: boolean }): unknown }

/** Manejador de una operación que llega por la malla. */
export type MeshHandler = (payload: any, link: MeshReplyChannel) => void

/** Opciones de la malla (`new Mesh`). */
export interface MeshOptions {
  urls?: string[]
  identity?: NodeIdentity | null
  registry: import('../peers.js').PeerRegistry
  onDeliver: MeshHandler
  onRelay?: MeshHandler
  onRelayFailed?: MeshHandler
  onPeerGone?: MeshHandler
  onPairRedeem?: MeshHandler
  onPairResult?: MeshHandler
  onChanOp?: MeshHandler
  onChanResult?: MeshHandler
  onChanEvent?: MeshHandler
  onEncPub?: MeshHandler
  log?: (...args: unknown[]) => void
}

// ── server.js ─────────────────────────────────────────────────────────────────

/** El WebSocket de un cliente, con lo que el proxio le cuelga al conectarse. */
export type ClientSocket = import('ws').WebSocket & {
  /** la instancia; se pone al aceptar la conexión, antes de atender ningún mensaje */
  token: string
  isAlive?: boolean
}

/**
 * Un mensaje JSON de un cliente. Viene de fuera y sin validar: cada manejador comprueba
 * lo que usa (`typeof`, `Array.isArray`…) antes de fiarse.
 */
export interface ClientMessage { type?: string, [key: string]: any }

/** Una conexión viva, por instancia. */
export interface Connection {
  ws: ClientSocket
  ip: string
  channel: string | null
  channelData: unknown
  connectedAt: number
  /** la app que dijo ser al identificarse (cola y timbre por app) */
  app?: string | null
  /** si publicó en un canal de otro nodo: la llave de ese nodo */
  remoteChannelOwner?: string
}

/** Dónde vive un canal: aquí, en un peer conocido, o en un nodo que no se conoce. */
export type ChannelHome =
  | { owner: null, local: true, known: true }
  | { owner: Peer, local: false, known: true }
  | { owner: null, local: false, known: false }

/** Un miembro publicado en un canal público. */
export interface ChannelEntry { token: string, publishedAt: number }

/** Un `message` dirigido a otra instancia, esperando acuse del otro nodo. */
export interface PendingRelay { ws: ClientSocket, message: ClientMessage, toInstance: string, timer: ReturnType<typeof setTimeout> }

/** Una operación de canal reenviada al nodo dueño, esperando respuesta. */
export interface PendingChanOp { ws: ClientSocket, message: ClientMessage, timer: ReturnType<typeof setTimeout> }

/** Canje de una cita preguntando a los peers, esperando sus respuestas. */
export interface PendingRedeem {
  ws: ClientSocket
  message: ClientMessage
  expected: number
  received: number
  replies: Array<{ instance: string, pubkey: string | null }>
  resolve?: () => void
  timer: ReturnType<typeof setTimeout> | null
}

/** Anuncio firmado de la llave de cifrado de una identidad. */
export interface EncPubStatement { v: 1, op: 'encpub', aud: string, publickey: string, ts: number, encpub: string, [key: string]: unknown }

/** El anuncio guardado (sobre entero, para que quien pregunte verifique la firma). */
export interface EncPubEntry { data: EncPubStatement, signature: string, ts: number }

/**
 * Un acta de perfil tal como llega (de un cliente o de la caché). Sin validar: las funciones
 * de `server.js` (`verifyActaSeal`, `canSeal`…) comprueban cada campo antes de fiarse.
 */
export interface WireActa {
  v?: number
  profileId?: unknown
  sealer?: unknown
  sealedBy?: unknown
  seq?: number
  sig?: unknown
  members?: Array<{ pub?: string, caps?: unknown } | null>
  renounced?: Array<{ member?: string, caps?: unknown } | null>
  sealerLink?: any
  sealerChanged?: boolean
  card?: unknown
  [key: string]: unknown
}

/** Lo que se cuenta del timbre al aviso del navegador (`ringHint`). */
export interface RingHint { sealed?: string, why?: Record<string, unknown> }

/** Suscripción de Web Push del navegador. */
export interface WebPushSubscription { kind?: undefined, endpoint: string, keys: { p256dh: string, auth: string } }
/** Timbre de la app nativa de Android. */
export interface FcmSubscription { kind: 'fcm', token: string }
/** Despertar a una bóveda alojada (Lambda) llamando a su URL. */
export interface WakeSubscription { kind: 'wake', url: string, channel?: string, self?: true }
/** Lo que se guarda por pubkey y app para tocar el timbre. */
export type StoredSubscription = WebPushSubscription | FcmSubscription | ApnsSubscription | WakeSubscription
