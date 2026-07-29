# Federación y descentralización del transporte

El proxy es el transporte del ecosistema Dotrino. Esta nota documenta cómo se
descentraliza (varios proxios federados) y qué queda **diferido a futuro** para no
sobre-ingenierizar mientras haya pocos nodos.

## Qué está implementado (hoy)

### Federación server-to-server
Varios proxios independientes se reenvían mensajes por pubkey, así un mensaje
llega aunque el destinatario esté en OTRO proxio.

- **Home**: en cada `identify`, el proxio se registra como "home" de esa pubkey
  (tabla `home_registrations`, TTL 7 días). Permite saber dónde encolar.
- **Ruteo**: `sendByPubkey` entrega local si el destinatario está ahí; si no,
  reenvía a los peers (`POST /federate`). El emisor además encola local como
  **fallback** (sin pérdida; la app dedup por `mid`). El receptor federado
  entrega si está online, o encola si es el home; si no, descarta (no acumula en
  intermedios). **Sin re-reenvío → sin loops.**
- **Config**: `PROXY_PEERS=https://peer1,https://peer2` (allowlist).
  Apagado sin `PROXY_PEERS` (single-node). Ver también `PROXY_PUBLIC_URL` en
  `.env.example`. **`PROXY_NODE_PREFIX` ya no existe**: el id sale de la llave.
- **Seguridad**: el payload va E2E + firmado → los proxios son tránsito ciego.
  Firma de identidad estricta (no acepta inválidas).

### Identidad de nodo: el id se DERIVA de la llave
Cada nodo tiene una **llave propia** —la del vault, `vault-service/service-identity.json`,
la misma con la que está enrolado— y su **id sale de esa llave**:

```
llave pública → punto comprimido SEC1 (33 bytes) → sha256 → base-35 → 12 caracteres
```

Esto es lo que responde la pregunta *"¿quién acepta a un proxio nuevo en la
red?"*: **nadie tiene que aceptarlo**. Como el id se recalcula de la llave y se
**verifica al recibirlo**, usar el id de otro exige su llave privada. Lo único
que se acepta o no es una **arista** —con quién federo—, y eso lo decide cada
operador para sí mismo, que es lo único compatible con "cualquiera puede
autohospedar".

> Antes el id eran 2 caracteres que el proxio **declaraba** (`PROXY_NODE_PREFIX`)
> y nadie verificaba: se lo quedaba el primero que lo dijera. Además no había
> ancho que sirviera — 1.225 valores chocan entre nodos honestos con 21 % de
> probabilidad ya a los 25 nodos, y como las identidades de nodo son gratis,
> acaparar el espacio entero costaba **0,1 s** de generar llaves.

- **Se hashea la forma CANÓNICA, no el JWK serializado.** El mismo par de llaves
  exportado por Node y por el navegador produce strings con los campos en otro
  orden, así que un id derivado del string cambiaría al re-exportar la misma
  llave.
- **`GET /node`** — anuncio **autofirmado**: `{body:{v,nodeId,pubkey,url,ts,nonce}, signature}`.
- **Pineo**: al arrancar, cada nodo baja el `/node` de sus peers, **comprueba que
  el id se deriva de la pubkey** y lo pinea en SQLite (`peer_nodes`). Si ese URL
  vuelve con otra pubkey, se rechaza y se grita en el log: un cambio legítimo de
  llave es justo cuando el operador quiere enterarse.
- **`POST /federate`** exige un sobre **firmado por un peer pineado**, con `ts` +
  `nonce` (ventana ±5 min y memoria de nonces) para cerrar el replay.
- **Descubrimiento adaptativo**: mientras falte algún peer por pinear reintenta
  cada 15 s; con todos pineados pasa a 10 min. Además, un `hello` de un nodo
  desconocido dispara un descubrimiento inmediato (con tope de uno cada 2 s):
  casi siempre es un peer configurado que arrancó después. Con un intervalo fijo largo, un
  deploy simultáneo dejaba la federación andando **en un solo sentido** (A tenía
  pineado a B pero B no a A) durante 10 minutos, que es peor que no andar porque
  no se nota.
- **`GET /peers`** — diagnóstico: mi id, los peers configurados, los
  pineados y el estado de cada enlace de la malla. Es lo primero que hay que
  mirar cuando "a veces no llegan".

### Malla s2s (WebSocket persistente)
El transporte entre nodos es un **WebSocket por peer**, no un POST por mensaje:

- **Topología**: cada nodo DISCA a cada peer (`/_s2s`), así que entre dos nodos
  hay dos sockets y cada uno manda por el suyo. Un socket de más a cambio de no
  tener que resolver quién gana cuando los dos discan a la vez.
- **NAT**: como el nodo disca hacia afuera, un proxio detrás de un router
  doméstico ya puede federar. Con `POST /federate` era imposible: exigía ser
  alcanzable desde fuera.
- **Handshake**: el que recibe manda un reto; el que disca lo firma con la llave
  del nodo y el receptor verifica contra la pubkey **pineada**. El reto fresco
  por conexión cierra el replay sin firmar cada trama (una verificación ECDSA
  por conexión, no por mensaje).
- **Orden y acuse**: cada trama lleva `seq` y se guarda hasta su `ack`; al
  reconectar se reenvía lo pendiente (hasta 500 tramas). El orden lo da TCP por
  socket. El acuse es de RECEPCIÓN DEL NODO, no de entrega al usuario: si no,
  el emisor reenviaría para siempre algo que ya llegó.
- **Reconexión**: backoff de 0,5 s a 10 s con jitter ±25 %. El tope es bajo a
  propósito: un peer caído casi siempre es un deploy y vuelve en segundos.
- **Apagado limpio**: `gracefulShutdown` avisa `bye` a los peers antes de salir.
  Antes era imposible — cerraba los sockets y llamaba a `process.exit(0)` en la
  línea siguiente, de forma síncrona, así que en CADA deploy los peers seguían
  ruteando hacia un proceso muerto hasta que se les caía el enlace solo.
- `POST /federate` sigue existiendo (firmado) como reserva para un peer sin
  enlace de malla.

> **Se eliminó `PROXY_FEDERATION_TOKEN`.** Era un secreto simétrico compartido:
> no distinguía QUÉ nodo hablaba, así que quien lo tuviera podía inyectar
> mensajes haciéndose pasar por cualquier nodo, y vivía en texto plano en el
> config de PM2. La firma por nodo lo reemplaza y además no hay nada que
> compartir al sumar un nodo nuevo.

### Cliente: descubrimiento + selección
- **Directorio**: `https://dotrino.com/nodes.json` lista los nodos. El cliente
  lo baja (cache + fallback) → nodos nuevos aparecen sin rebuild.
- **Auto-selección** por latencia + reputación local al arrancar (si no hay home
  manual elegido).
- **Auto-failover**: si el proxio cae, el cliente salta al mejor nodo sano.
- **Reputación LOCAL de nodos** (automática, sin prompts): el cliente recuerda
  latencia + fallos recientes y evita los que fallaron (con decaimiento 30min).
- **Override manual**: selector de proxio + agregar uno custom.

### Cómo agregar un nodo
1. Levantar el proxio (systemd o Docker; ver `SELF-HOSTING.md`).
2. Cruzar `PROXY_PEERS` con los demás nodos. No hay ningún secreto que
   compartir: cada nodo se identifica firmando con su llave.
3. Agregarlo a `nodes.json` (commit al repo del catálogo `dotrino`).
→ Los clientes lo descubren, lo eligen por latencia, le hacen failover.

---

## Diferido a futuro (NO implementar con pocos nodos)

### Reputación de nodos COMPARTIDA (nivel B)
Hoy la reputación de nodos es **local** (cada cliente con su experiencia). El
nivel B la comparte vía el 5º pilar (`@dotrino/reputation`),
ponderada por web-of-trust, para que te beneficies de la experiencia de tu red y
evites nodos que ellos flaggearon (defensa real contra el "nodo hostil").

Requiere:
- **Identidad de operador**: cada nodo tiene una pubkey (del vault del operador),
  publicada en `nodes.json` y **firmando su propia entrada** del directorio (así
  el directorio deja de necesitar confianza ciega en el host).
- **Atestaciones de comportamiento firmadas y AUTOMÁTICAS**: el cliente emite
  atestaciones sobre la pubkey del nodo (indicadores tipo `uptime`, `fiabilidad`)
  derivadas de lo medido — sin prompts. Se agregan con el mismo anti-sybil:
  atestaciones de identidades que no rastreás a tu confianza pesan ~0 → nadie
  review-bombea un nodo bueno en tu vista.
- **Privacidad**: publicar qué nodos usás revela metadata. Mitigar (opt-in,
  agregación, o solo compartir señales gruesas).
- **Selección**: ponderar nodos por reputación-de-red ADEMÁS de latencia local.

Razón para diferir: con 2-3 nodos no aporta (la reputación local alcanza); recién
con una malla grande de operadores diversos justifica el costo y la complejidad.

### Otros futuros
- **Home preferido en el vault** (`id.dotrino.com`): que tu proxio elegido viaje
  con tu identidad entre dispositivos (y, eventualmente, que los contactos
  conozcan tu home para ruteo directo).
- **Directorios comunitarios**: aceptar múltiples `nodes.json` (no solo el de
  dotrino.com) para no depender de un seed único.
- **Selección por región**: pista de región en el directorio + geo para elegir
  el nodo más cercano.
- **Overlay P2P (libp2p/DHT)**: relays solo como fallback de NAT; el descubrimiento
  por DHT en vez de directorio. El paso más ambicioso.
