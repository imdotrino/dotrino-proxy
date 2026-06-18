# Imagen del proxy WebSocket. Usa node:sqlite (built-in, sin addon nativo) para
# la persistencia durable → Node 22.5+ con --experimental-sqlite.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV PORT=4001
# La base SQLite vive en /data (montá un volumen ahí para persistirla).
ENV PROXY_DB_FILE=/data/proxy-data.db
RUN mkdir -p /data
EXPOSE 4001

CMD ["node", "--experimental-sqlite", "server.js"]
