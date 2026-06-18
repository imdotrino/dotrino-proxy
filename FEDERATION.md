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
- **Config**: `PROXY_PEERS=https://peer1,https://peer2` (allowlist) +
  `PROXY_FEDERATION_TOKEN` compartido. Apagado sin `PROXY_PEERS` (single-node).
- **Seguridad**: el payload va E2E + firmado → los proxios son tránsito ciego.
  `/federate` exige token. Firma de identidad estricta (no acepta inválidas).

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
2. Cruzar `PROXY_PEERS` con los demás nodos + mismo `PROXY_FEDERATION_TOKEN`.
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
