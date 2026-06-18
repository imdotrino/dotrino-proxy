# Despliegue en producción — `proxy.dotrino.com`

Guía para levantar el proxy WebSocket de Dotrino en producción, incluido el
Web Push (timbre) y la persistencia SQLite agregados en esta versión.

## 1. Requisitos

- **Node.js ≥ 22.5** (obligatorio: usamos el módulo nativo `node:sqlite`).
  Verificá con `node -v`.
- Un reverse proxy con TLS (nginx/Caddy) que termine HTTPS/WSS y haga upgrade a
  WebSocket hacia el puerto local del proceso.

## 2. Primer despliegue

```bash
# en el servidor
git clone git@github.com:imdotrino/dotrino-proxy.git
cd simple-websocket-proxy
npm ci                 # instala deps exactas (ws, dotenv, web-push)
cp .env.example .env   # opcional: editar si querés config explícita
```

### `.env` (todo opcional)

| Variable | Default | Notas |
|----------|---------|-------|
| `PORT` | `4001` | Puerto local que escucha el proceso. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | *(autogenerado)* | Si las dejás vacías, el proxy genera un par la **primera vez** y lo persiste en SQLite (estable entre reinicios). Definilas solo para control explícito o para **compartir el par entre varias instancias**. |
| `VAPID_SUBJECT` | `mailto:admin@dotrino.com` | Contacto del header VAPID. Poné un mailto real. |
| `PROXY_DB_FILE` | `./proxy-data.db` | Ruta de la base SQLite. |

> ⚠️ **No commitees `.env` ni `proxy-data.db`** (ya están en `.gitignore`). El
> `.env` contiene la VAPID privada y la DB contiene VAPID + subscriptions.

## 3. Correr como servicio systemd (recomendado)

Crear `/etc/systemd/system/dotrino-proxy.service`:

```ini
[Unit]
Description=Dotrino WebSocket Proxy
After=network.target

[Service]
Type=simple
User=seyacat
WorkingDirectory=/home/imdotrino/dotrino-proxy
ExecStart=/usr/bin/env node server.js
Restart=always
RestartSec=3
# Node >= 22.5 en PATH; si usás nvm, apuntá al binario absoluto:
# ExecStart=/home/dotrino/.nvm/versions/node/v22.x/bin/node server.js
EnvironmentFile=/home/imdotrino/dotrino-proxy/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dotrino-proxy
sudo systemctl status dotrino-proxy
journalctl -u dotrino-proxy -f      # logs en vivo
```

Ventajas sobre `start.sh` (screen + `npm run dev`): auto-restart ante caídas,
arranca al boot, logs centralizados, y `npm start` (no nodemon, que reiniciaría
ante cualquier cambio de archivo).

## 4. Reverse proxy (nginx) — `wss://proxy.dotrino.com`

```nginx
server {
    listen 443 ssl http2;
    server_name proxy.dotrino.com;

    ssl_certificate     /etc/letsencrypt/live/proxy.dotrino.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/proxy.dotrino.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;     # WebSocket upgrade
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;                   # conexiones largas
    }
}
```

El cliente usa `wss://proxy.dotrino.com` (default de `@dotrino/proxy-client`).

## 5. Persistencia y backups

`proxy-data.db` (SQLite, WAL) guarda lo **durable**:
- el par **VAPID** (si fue autogenerado),
- las **push subscriptions** (pubkey → subscription),
- la **cola offline** 24 h.

Recomendaciones:
- **Backup periódico** de `proxy-data.db*` (incluye `-wal` y `-shm`). Mejor con
  `sqlite3 proxy-data.db ".backup backup.db"` para consistencia.
- **No borres la DB**: perder el par VAPID autogenerado invalida **todas** las
  subscriptions (los usuarios tendrían que re-suscribirse). Si necesitás claves
  fijas e independientes de la DB, definilas en `.env`.

## 6. Actualizar (deploy de nueva versión)

```bash
cd /home/imdotrino/dotrino-proxy
git pull
npm ci
sudo systemctl restart dotrino-proxy
journalctl -u dotrino-proxy -n 50 --no-pager
```

Al arrancar deberías ver en los logs:

```
[push] Web Push habilitado (VAPID .env|sqlite|autogenerado).
[persist] cola offline rehidratada: N pubkey(s), M bytes   (si había cola)
[push] K subscription(s) rehidratadas de SQLite            (si había subs)
🚀 Servidor WebSocket proxy ... Puerto: 4001
```

## 7. Checklist de verificación post-deploy

- [ ] `node -v` ≥ 22.5 en el server.
- [ ] `systemctl status dotrino-proxy` → active (running).
- [ ] Log muestra `[push] Web Push habilitado`.
- [ ] `wss://proxy.dotrino.com` responde (probar con un cliente del ecosistema).
- [ ] `proxy-data.db` se crea y persiste (no en RAM ni en /tmp).
- [ ] Backup de `proxy-data.db` programado.
