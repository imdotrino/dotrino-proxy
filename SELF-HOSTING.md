# Correr tu propio proxy

`proxy.dotrino.com` no tiene por qué ser el único. Cualquiera puede levantar un
proxy: es el **transporte** del ecosistema (mensajería por token, canales,
`identify`, `sendByPubkey` con cola offline 24h, Web Push, y señalización WebRTC
con fallback). Como el contenido viaja **cifrado E2E y firmado** por el vault de
cada identidad, el proxy es un **caño tonto**: no ve ni puede falsificar nada.

> Nota: hoy cada proxy es independiente — dos personas tienen que estar en el
> **mismo** proxy para hablarse (o usar WebRTC una vez conectadas). La
> **federación** entre proxies (que se reenvíen al *home proxy* firmado de cada
> pubkey) es la fase siguiente; esto es el paso de autohospedaje.

## 1. Requisitos

- Docker + Docker Compose.
- Un dominio (ej. `proxy.tudominio.com`) apuntando **A/AAAA a este host**, con
  **80 y 443 abiertos** (Caddy saca el cert TLS). **DNS directo, sin la nube
  naranja de Cloudflare** — el proxy naranja **corta los WebSocket de larga
  vida** (timeouts de inactividad). Usá grey-cloud / A directo.

## 2. Levantarlo (turnkey)

```bash
git clone https://github.com/imdotrino/dotrino-proxy
cd simple-websocket-proxy
cp .env.docker.example .env
# editá .env: PROXY_DOMAIN y VAPID_SUBJECT (tu email)
docker compose up -d
```

Levanta el **proxy** + **Caddy** (TLS automático + WebSocket passthrough). En un
minuto tenés `wss://proxy.tudominio.com` y `https://proxy.tudominio.com/health`
→ `{"ok":true}`.

### Probar sin dominio/TLS

En `docker-compose.yml` comentá `caddy` y descomentá `ports: ["4001:4001"]` del
servicio `proxy`. Después `docker compose up -d proxy` y conectá un cliente a
`ws://localhost:4001`.

## 3. Usar tu proxy desde una app

El cliente acepta la URL — no hay nada hardcodeado:

```js
import { getWebSocketProxyClient } from '@dotrino/proxy-client'
const client = getWebSocketProxyClient({ url: 'wss://proxy.tudominio.com' })
```

## 4. Web Push (VAPID)

El proxy **autogenera** un par VAPID la primera vez y lo **persiste en SQLite**
(estable entre reinicios mientras conserves el volumen `proxy-data`). Las apps
obtienen la clave pública del proxio al conectar. Si querés un par explícito,
poné `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` en `.env`
(`node -e "console.log(require('web-push').generateVAPIDKeys())"`).

## 5. Operación

- **Persistencia**: la base SQLite vive en el volumen `proxy-data`
  (`/data/proxy-data.db`): cola offline (24h), push subscriptions, scheduled
  pushes y las claves VAPID. Sobrevive a `up`/`down`; se borra con `down -v`.
- **Estado efímero** (tokens, canales, conexiones) vive solo en RAM, por diseño.
- **Actualizar**: `git pull && docker compose up -d --build`.
- **Logs**: `docker compose logs -f proxy`.
- **Rate-limit**: por IP, detrás de Caddy (que pasa `X-Forwarded-For`).

## Notas

- Requiere Node 22.5+ por `node:sqlite` (la imagen lo corre con
  `--experimental-sqlite`). No hay addons nativos que compilar.
- No requiere Cloudflare ni terceros: TLS propio del origen.
