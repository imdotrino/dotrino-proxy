# Simple WebSocket Proxy Simplificado

> **Parte del ecosistema [Dotrino](https://dotrino.com).** Dotrino es un ecosistema de aplicaciones centradas en la privacidad de los datos: tu información es tuya, y las decisiones sobre ella también — qué compartes, con quién, cuándo y por qué. Sin anuncios, sin cookies, sin rastreo de datos, sin vender tu identidad a nadie.

Un servidor WebSocket proxy que implementa las 4 reglas especificadas en `definition.txt`:
1. Asignación de tokens de 4 caracteres alfanuméricos (1-9, A-Z)
2. Envío de mensajes a uno o múltiples destinos
3. Seguimiento de pares de conexión para notificaciones de desconexión
4. Canales públicos con expiración de 20 minutos

## Características

- **Tokens cortos alfanuméricos**: 4 caracteres (1-9, A-Z) asignados automáticamente
- **Mensajería múltiple**: Envío a uno o varios destinos simultáneamente
- **Notificaciones de desconexión**: Aviso cuando clientes pareados se desconectan
- **Canales públicos**: Publicación y listado de tokens en canales (TTL 20 min, hard cap 100 tokens/canal)
- **Identidad opt-in (`identify`)**: bind de una pubkey ECDSA estable al token actual mediante un sobre firmado.
- **Direccionamiento por pubkey (`to_publickey`)**: una vez identificadas las partes, el sender direcciona por pubkey en lugar de token.
- **Fan-out multi-instancia**: el proxy mantiene `pubkey → Set<token>` y entrega cada mensaje a todas las instancias activas de la misma pubkey (web + extensión + tabs + móvil simultáneamente).
- **Cola offline 24 h**: si ninguna instancia de la pubkey está conectada, el mensaje queda encolado hasta 24 h. Caps: 200 msgs / 1 MB por pubkey, 64 MB global con eviction oldest-first. **Single-drain**: el primer cliente que identifica drena la cola y se borra.
- **Web Push ("timbre")**: si una pubkey offline tiene una push subscription registrada, además de encolar el proxy envía un Web Push **sin contenido** (VAPID, estándar, sin SDK de Firebase) que despierta al Service Worker del destinatario para que reconecte y baje su cola. Ver `enablePush()` en `@dotrino/proxy-client`.
- **Push programado (auto-recordatorios)**: una pubkey puede programar pushes **a sí misma** (one-shot por timestamp o recurrente por `cron`+`tz`, vía `cron-parser`). Self-only (sobre firmado por el vault, target = firmante) → sin vector de spam. Un loop dispara los jobs vencidos. Catch-up "descartar lo vencido": no dispara jobs que vencieron mientras el proxy estuvo caído. Persistido en SQLite (`scheduled_pushes`). Ver `schedulePush()` en el cliente. Tick configurable con `SCHED_TICK_MS`.
- **Rate limit de dos niveles** por (token, type): soft → `abuse_notice` a los receptores, hard → cierre de conexión + ban de IP 30 min.
- **Credenciales TURN temporales (`turn-credentials`)**: el proxy administra el TURN de Cloudflare para WebRTC. La llave de Cloudflare vive solo en el servidor; a los clientes se les emiten credenciales **efímeras** (TTL default 10 min), solo en conexiones **identificadas** (sobre firmado + bind pubkey↔token previo), con cache por pubkey, cuota por pubkey/hora y **techos de gasto globales** (memoria, emisiones/hora, timeout) que acotan el abuso. El gate de acceso por **reputación anclada en la red de confianza del operador** (que un tercero replica con SU raíz) es el modelo previsto — ver **[`docs/turn-acceso.md`](./docs/turn-acceso.md)**. Apagado si faltan `TURN_KEY_ID`/`TURN_KEY_API_TOKEN` (los clientes caen a STUN-only). Ver `enableTurn()` en `@dotrino/proxy-client`.
- **Persistencia durable (SQLite nativo)**: la cola offline y las push subscriptions se respaldan en SQLite (`node:sqlite`, write-through) y se rehidratan al arrancar. Los mapas token↔pubkey y los canales siguen siendo efímeros (RAM), por diseño.

## Instalación

```bash
npm install
cp .env.example .env   # luego completá las claves VAPID
```

### Configuración (`.env`)

| Variable | Descripción |
|----------|-------------|
| `PORT` | Puerto del servidor (default 4001). |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Par VAPID para Web Push. **Opcional**: si faltan, el proxy autogenera un par la primera vez y lo persiste en SQLite (estable entre reinicios). Definilas solo para control explícito o para compartir el par entre varias instancias. Generar manualmente: `node -e "console.log(require('web-push').generateVAPIDKeys())"`. |
| `VAPID_SUBJECT` | Contacto para el header VAPID (`mailto:` o `https:`). |
| `PROXY_DB_FILE` | Archivo SQLite de persistencia durable (default `./proxy-data.db`). |
| `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` | TURN key de Cloudflare Realtime (dashboard → Realtime → TURN). **Fallback para self-hosters**: el camino oficial es el **vault** (ver abajo). Sin llaves (ni vault) la op `turn-credentials` responde `enabled:false` y los clientes quedan STUN-only. |
| `TURN_TTL_SECONDS` | Vida de cada credencial TURN emitida (default 600, rango 60–86400). |
| `TURN_MAX_PER_HOUR` | Emisiones de credenciales por pubkey/hora (default 12). |
| `TURN_GLOBAL_MAX_PER_HOUR` | Techo GLOBAL de emisiones reales a Cloudflare/hora sumando todas las pubkeys (default 2000). Protege la cuenta de Cloudflare aunque un atacante rote pubkeys autofirmadas. |
| `TURN_MAX_TRACKED` | Tope de pubkeys distintas retenidas en memoria (default 50000); barrido periódico + evicción oldest-first. |
| `TURN_FETCH_TIMEOUT_MS` | Timeout del fetch a Cloudflare (default 10000). |
| `VAULT_SERVICE_DIR` | Dónde vive la identidad de servicio del proxy para leer secretos del vault (default `./vault-service`). |

> **Requiere Node ≥ 22.5** por el módulo nativo `node:sqlite`.

### Configuración desde el vault (camino oficial)

El proxio es **un agente de Dotrino como cualquier otro**: puede correr suelto con
su `.env` o enrolado a un vault. Enrolado, **el vault manda**: lo que entrega se
vuelca en el entorno del proceso **pisando** lo que dijera el `.env`. No lo
reemplaza —el `.env` sigue arrancando la máquina— pero deja de tener la última
palabra. Eso es lo que hace barata la **rotación**: se cambia el valor en un solo
lugar y ningún `.env` viejo olvidado en un VPS puede seguir ganando. Al arrancar,
el log dice qué claves tuvo que pisar; si aparece alguna, ese `.env` tiene basura
por limpiar.

La respuesta del vault viaja **sellada** (el propio proxio que la transporta no
puede leerla) y **firmada** por la maestra, verificada contra la `iss` pineada en
el enrolamiento.

**Lo que NO hace: esperar al vault.** El proxio no puede bloquear su arranque
pidiendo configuración, porque el vault habla con sus servicios **por el proxio**:
esperarlo sería esperar a alguien que necesita que el proxio ya esté escuchando.
Así que el transporte levanta siempre con lo que haya y la configuración del vault
se aplica cuando llega. Consecuencia honesta: lo que sólo se lee al arrancar
(`PORT`, `HOST`, `PROXY_PEERS`, VAPID…) queda en el entorno pero **no toma efecto
hasta el próximo reinicio**, y el log lo avisa en vez de dejarte creer que ya está.
Lo que sí se re-aplica en caliente es TURN, con sus topes incluidos.

**Cuando cambias algo en la bóveda, avisa.** Al guardar un secreto, la bóveda manda
un aviso firmado a los agentes de su `ns`. El agente estándar **termina** y su
supervisor lo levanta limpio —así lee todo fresco y, sobre todo, el valor viejo deja
de existir en su memoria—, pero **el proxio no**: reiniciarlo corta las conexiones de
todo el ecosistema, incluida la de la bóveda que mandó el aviso. Lo anota, lo dice en
el log y lo publica en **`GET /peers`** bajo `vault`:

```jsonc
"vault": null                                        // al día
"vault": { "reason": "changed", "since": "…" }        // hay configuración sin aplicar
"vault": { "reason": "revoked", "since": "…" }      // lo revocaron: re-enrólalo o bájalo
```

Cuando aparezca, reinícialo tú en el momento que menos duela.

**Identidad.** Un agente tiene **una** identidad y se la cede el vault: no adopta
cuentas y re-enrolar **reemplaza** la anterior. En el proxio esa llave es además su
identidad de red —el id de nodo se deriva de ella—, así que re-enrolar le cambia el
nombre en la red: mueren las instancias y citas vivas y los peers federados lo
rechazan hasta re-pinearlo. Si sólo quieres recargar la configuración, **no
enroles: reinicia**.

Enrolamiento (una vez):

```bash
# En el PC del vault:
dotrino-vault pair --service proxy          # imprime la invitación (URL + código)
dotrino-vault secret set proxy TURN_KEY_ID <id>
dotrino-vault secret set proxy TURN_KEY_API_TOKEN <token>

# En el host del proxy (pega la invitación tal cual, en cualquiera de sus formas):
node enroll-vault.js '<invitación>'            # imprime un código
# En el PC del vault:
dotrino-vault approve <código>

# Reiniciar el proxy: al arrancar detecta ./vault-service/ y pide su configuración.
```

## Uso

### Iniciar servidor

```bash
npm start
# o para desarrollo con recarga automática
npm run dev
```

El servidor se inicia en `ws://localhost:4001` por defecto (configurable con variable de entorno `PORT`).

## Respuestas del Servidor

### Al conectar
```json
{
  "type": "connected",
  "token": "ABCD",
  "timestamp": "2026-03-01T04:33:38.141Z"
}
```

### Mensaje recibido de otro cliente
```json
{
  "type": "message",
  "from": "ABCD",
  "message": "Texto del mensaje",
  "timestamp": "2026-03-01T04:33:38.141Z"
}
```

### Confirmación de mensaje enviado
```json
{
  "type": "message_sent",
  "sent": 2,
  "total": 2,
  "timestamp": "2026-03-01T04:33:38.141Z"
}
```

### Confirmación de mensaje enviado con errores
```json
{
  "type": "message_sent",
  "sent": 1,
  "total": 2,
  "failed": ["EFGH"],
  "timestamp": "2026-03-01T04:33:38.141Z"
}
```

### Confirmación de publicación en canal
```json
{
  "type": "published",
  "channel": "nombre-del-canal",
  "timestamp": "2026-03-01T04:33:38.141Z"
}
```

### Confirmación de desconexión manual
```json
{
  "type": "disconnect_confirmation",
  "target": "ABCD",
  "timestamp": "2026-03-01T04:33:38.141Z"
}
```

### Lista de tokens en canal
```json
{
  "type": "channel_list",
  "channel": "nombre-del-canal",
  "tokens": ["ABCD", "EFGH", "IJKL"],
  "count": 3,
  "maxEntries": 100,
  "timestamp": "2026-03-01T04:33:38.141Z"
}
```

### Notificación de entrada al canal
Emitida a los demás miembros del canal cuando alguien hace `publish`:
```json
{
  "type": "joined",
  "token": "ABCD",
  "channel": "nombre-del-canal",
  "timestamp": "2026-05-01T12:00:00.000Z"
}
```

### Notificación de salida del canal
Emitida a los miembros restantes cuando alguien hace `unpublish`:
```json
{
  "type": "left",
  "token": "ABCD",
  "channel": "nombre-del-canal",
  "timestamp": "2026-05-01T12:00:00.000Z"
}
```

### Notificación de desconexión
Cuando un cliente se cierra, el servidor emite `disconnected` a:
- **Cada miembro de cada canal** en el que el cliente estaba publicado (incluye campo `channel`).
- **Pares emparejados** que no comparten canal (sin campo `channel`).

Forma con canal (broadcast por canal):
```json
{
  "type": "disconnected",
  "token": "ABCD",
  "channel": "nombre-del-canal",
  "timestamp": "2026-03-01T04:33:38.141Z"
}
```

Forma legacy (par sin canal compartido o `disconnect` manual):
```json
{
  "type": "disconnected",
  "token": "ABCD",
  "timestamp": "2026-03-01T04:33:38.141Z"
}
```

### Listar canales activos (descubrimiento)
```json
{
  "type": "channels_list",
  "channels": [
    { "name": "chat_room_general", "count": 3 },
    { "name": "chat_room_prueba", "count": 1 }
  ],
  "timestamp": "2026-05-01T12:00:00.000Z"
}
```

### Conteo de canal (consulta ligera)
```json
{
  "type": "channel_count",
  "channel": "nombre-del-canal",
  "count": 3,
  "maxEntries": 100,
  "timestamp": "2026-03-01T04:33:38.141Z"
}
```

### Error
```json
{
  "type": "error",
  "error": "Mensaje de error descriptivo"
}
```

## Protocolo WebSocket

### Conexión inicial
Conectar al servidor WebSocket:
```
ws://localhost:4001/
```

### Enviar mensaje
```json
{
  "to": ["ABCD", "EFGH"],
  "message": "Texto del mensaje"
}
```

### Desconectar manualmente de otro cliente
```json
{
  "type": "disconnect",
  "target": "ABCD"
}
```

### Publicar en canal
```json
{
  "type": "publish",
  "channel": "nombre-del-canal"
}
```

### Listar tokens en canal
```json
{
  "type": "list",
  "channel": "nombre-del-canal"
}
```

### Contar miembros en canal (sin firma)
Devuelve solo el número de tokens activos en el canal — útil para badges de presencia y polling barato.
```json
{
  "type": "channel_count",
  "channel": "nombre-del-canal"
}
```

## API Completa

Ver [API.md](API.md) para documentación detallada de todos los mensajes y respuestas.

## Testing

Suite con Vitest cubre tokens, mensajería, canales (publish/unpublish/list/channel_count), presencia (`joined`/`left`) y desconexiones (broadcast por canal, pareo, dedup, manual `disconnect`).

```bash
npm install
npm test            # corrida única
npm run test:watch  # modo watch
```

Los tests arrancan su propia instancia del servidor en un puerto OS-asignado, no requieren un servidor corriendo aparte.

## Rate limiting

Hay dos niveles, ambos por **token + tipo de operación**, configurables por env. Defaults:

| Tipo | Soft burst | Soft refill/s | Hard burst (×2) | Hard refill/s |
|---|---:|---:|---:|---:|
| `message` (regular) | 20 | 8 | 40 | 16 |
| `publish` | 5 | 1 | 10 | 2 |
| `unpublish` | 5 | 1 | 10 | 2 |
| `list` | 10 | 2 | 20 | 4 |
| `list_channels` | 5 | 1 | 10 | 2 |
| `channel_count` | 60 | 10 | 120 | 20 |
| `disconnect` | 5 | 1 | 10 | 2 |
| **global por token** | 60 | 15 | 120 | 30 |

### Tier 1 (soft) — abuse_notice

Cuando un token excede el soft, **el mensaje se procesa igual** pero el proxy emite:

```json
{
  "type": "abuse_notice",
  "from": "ABCD",
  "operation": "message",
  "severity": "soft",
  "timestamp": "..."
}
```

- Para `message`: el notice va a cada **destinatario** del mensaje original; ellos pueden registrar el incidente para penalizar el ranking del emisor.
- Para tipos especiales: el notice vuelve al **emisor** como aviso informativo.

### Tier 2 (hard) — error + close + ban IP

Cuando un token excede el hard (default 2× soft), el mensaje se rechaza y se cierra la conexión:

```json
{
  "type": "error",
  "error": "Hard rate limit exceeded for message",
  "retry_after_ms": 1800000,
  "limit_level": "hard",
  "limit_type": "per_type",
  "operation": "message"
}
```

La IP queda baneada por `RATE_LIMIT_BAN_MS` (default 30 min). Conexiones nuevas desde esa IP se cierran inmediatamente con un error de tipo `ip_ban`.

### Configuración por env

| Variable | Default | Descripción |
|---|---|---|
| `RATE_LIMIT_DISABLED` | — | Si es `1`, desactiva todo (útil en dev). |
| `RATE_LIMIT_<TYPE>_BURST` | ver tabla | Capacidad del cubo soft para `<TYPE>` (`MESSAGE`, `PUBLISH`, `UNPUBLISH`, `LIST`, `LIST_CHANNELS`, `CHANNEL_COUNT`, `DISCONNECT`, `GLOBAL`). |
| `RATE_LIMIT_<TYPE>_RATE` | ver tabla | Refill/s del cubo soft para `<TYPE>`. |
| `RATE_LIMIT_HARD_MULTIPLIER` | `2` | Factor del hard sobre el soft. |
| `RATE_LIMIT_BAN_MS` | `1800000` | Duración del ban por IP en ms. |

## Reglas del Sistema

### Tokens
- 4 caracteres alfanuméricos (1-9, A-Z)
- Asignados automáticamente al conectar
- Eliminados inmediatamente al desconectar
- No hay recuperación de conexión (nuevo token al reconectar)

### Mensajes
- El campo `to` puede ser string (un destino) o array (múltiples destinos)
- No se pueden enviar mensajes a uno mismo
- Los mensajes fallan silenciosamente para destinos no encontrados
- Campos `id` o `messageId` opcionales para correlacionar solicitudes con respuestas (se incluyen ambos si están presentes)

### Pares de Conexión
- Se almacenan cuando un mensaje se entrega exitosamente
- Se usan solo para notificar desconexiones
- Se eliminan cuando uno de los clientes se desconecta

### Canales Públicos
- Cada cliente puede publicarse en un canal a la vez
- Máximo 100 tokens por canal (FIFO)
- Los tokens expiran después de 20 minutos
- Cualquier cliente puede listar tokens en cualquier canal

## Estructura del Proyecto

```
simple-websocket-proxy/
├── server.js           # Servidor WebSocket principal
├── tokenManager.js     # Gestión de tokens
├── test/               # Suite Vitest (core, channels, presence, disconnect)
├── vitest.config.js    # Configuración de tests
├── API.md             # Documentación de API
├── package.json       # Dependencias
└── README.md          # Este archivo
```

## Comparación con Versión Anterior

| Característica | Versión Anterior | Versión Simplificada |
|----------------|------------------|----------------------|
| **Líneas de código** | 767 | 371 |
| **Modos host/guest** | Sí | No |
| **Suscripciones** | Sí | No |
| **Broadcast** | Sí | No |
| **Tokens** | 10 minutos de retención | Eliminación inmediata |
| **UUID/IP validación** | Compleja | Simple |
| **HTTP endpoints** | /status, /tokens | Ninguno |
| **Canales públicos** | FIFO 20 hosts | 100 tokens por canal |
| **Expiración** | 10 minutos | 20 minutos |

## Requisitos

- Node.js >= 14.0.0
- Dependencias: `ws`, `dotenv`

## Licencia

MIT