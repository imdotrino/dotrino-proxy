# WebSocket Proxy API Simplificado

## Descripción
Servidor WebSocket proxy que implementa las 4 reglas especificadas en `definition.txt`:
1. Asignación de tokens de 4 caracteres alfanuméricos (1-9, A-Z)
2. Envío de mensajes a uno o múltiples destinos
3. Seguimiento de pares de conexión para notificaciones de desconexión
4. Canales públicos con expiración de 20 minutos

## Conexión
Conectarse al servidor WebSocket:
```
ws://localhost:4001/
```

Al conectarse, el servidor responde con:
```json
{
  "type": "connected",
  "token": "ABCD",
  "timestamp": "2026-03-01T04:33:38.141Z"
}
```

## Mensajes

### Campos ID (opcionales)
Los mensajes pueden incluir campos `id` o `messageId` (o ambos) para correlacionar solicitudes con respuestas. Si se incluyen en el mensaje de solicitud, el servidor los incluirá en la respuesta correspondiente.

Ejemplo de mensaje con ID:
```json
{
  "id": 42,
  "to": ["ABCD"],
  "message": "Texto del mensaje"
}
```

Ejemplo de mensaje con messageId:
```json
{
  "messageId": 99,
  "to": ["ABCD"],
  "message": "Texto del mensaje"
}
```

Ejemplo de mensaje con ambos campos:
```json
{
  "id": 42,
  "messageId": 99,
  "to": ["ABCD"],
  "message": "Texto del mensaje"
}
```

El servidor responderá con los mismos campos ID:
```json
{
  "id": 42,
  "messageId": 99,
  "type": "message_sent",
  "sent": 1,
  "total": 1,
  "timestamp": "2026-03-01T04:33:38.141Z"
}
```

### Enviar mensaje a uno o múltiples destinos
```json
{
  "to": ["ABCD", "EFGH"],
  "message": "Texto del mensaje"
}
```

**Respuesta exitosa:**
```json
{
  "type": "message_sent",
  "sent": 2,
  "total": 2,
  "timestamp": "2026-03-01T04:33:38.141Z"
}
```

*Nota: Si el mensaje original incluye campos `id` o `messageId` (o ambos), la respuesta también los incluirá.*

**Respuesta con errores (algunos destinos no encontrados):**
```json
{
  "type": "message_sent",
  "sent": 1,
  "total": 2,
  "failed": ["EFGH"],
  "timestamp": "2026-03-01T04:33:38.141Z"
}
```

### Recibir mensaje
```json
{
  "type": "message",
  "from": "ABCD",
  "message": "Texto del mensaje",
  "timestamp": "2026-03-01T04:33:38.141Z"
}
```

### Publicar en canal público
Cada cliente puede publicarse en un canal a la vez. El canal debe seguir el nuevo formato:
```json
{
  "type": "publish",
  "channel": {
    "data": {
      "name": "nombre-del-canal",
      "publickey": "clave-publica-del-cliente",
      "...": "otros datos opcionales"
    },
    "signature": "firma-de-los-datos"
  }
}
```

**Requisitos:**
- El campo `data` debe contener al menos `name` (string) y `publickey` (string)
- El campo `signature` debe ser una firma válida de los datos
- El JSON completo no debe exceder 1000 caracteres
- La firma será validada por el servidor

**Respuesta:**
```json
{
  "type": "published",
  "channel": "nombre-del-canal",
  "data": {
    "name": "nombre-del-canal",
    "publickey": "clave-publica-del-cliente",
    "...": "otros datos opcionales"
  },
  "timestamp": "2026-03-01T04:33:38.141Z"
}
```

### Despublicar de canal
```json
{
  "type": "unpublish",
  "channel": {
    "data": {
      "name": "nombre-del-canal",
      "publickey": "clave-publica-del-cliente",
      "...": "otros datos opcionales"
    },
    "signature": "firma-de-los-datos"
  }
}
```

### Listar tokens en canal
Obtener los últimos 100 tokens no expirados en un canal. Requiere el bloque firmado.
```json
{
  "type": "list",
  "channel": {
    "data": {
      "name": "nombre-del-canal",
      "publickey": "clave-publica-del-cliente",
      "...": "otros datos opcionales"
    },
    "signature": "firma-de-los-datos"
  }
}
```

**Respuesta:**
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

Para obtener solo el conteo sin firmar el canal, usar `channel_count` (más abajo).

### Desconectar manualmente de otro cliente
Remover manualmente un par de conexión y notificar a ambas partes.
```json
{
  "type": "disconnect",
  "target": "ABCD"
}
```

**Respuesta exitosa:**
```json
{
  "type": "disconnect_confirmation",
  "target": "ABCD",
  "timestamp": "2026-03-01T04:33:38.141Z"
}
```

**Notificación enviada a ambas partes:**
```json
{
  "type": "disconnected",
  "token": "ABCD",
  "timestamp": "2026-03-01T04:33:38.141Z"
}
```

### Listar canales activos (descubrimiento, sin firma)
Devuelve todos los canales con al menos un token publicado, junto con su `count`. Útil para descubrir salas creadas dinámicamente. Acepta un `prefix` opcional para filtrar.

**Solicitud:**
```json
{ "type": "list_channels", "prefix": "chat_room_" }
```

**Respuesta:**
```json
{
  "type": "channels_list",
  "prefix": "chat_room_",
  "channels": [
    { "name": "chat_room_general", "count": 3 },
    { "name": "chat_room_prueba", "count": 1 }
  ],
  "timestamp": "2026-05-01T12:00:00.000Z"
}
```

- Sin `prefix` devuelve todos los canales (campo `prefix` se omite en la respuesta).
- Acepta `id` / `messageId` y los echoa.
- No requiere firma.

### Contar miembros en canal (consulta ligera, sin firma)
Obtener solo el número de tokens activos en un canal, sin tener que firmar el bloque completo del canal. Útil para badges de presencia y polling barato.

```json
{
  "type": "channel_count",
  "channel": "nombre-del-canal"
}
```

**Respuesta:**
```json
{
  "type": "channel_count",
  "channel": "nombre-del-canal",
  "count": 3,
  "maxEntries": 100,
  "timestamp": "2026-03-01T04:33:38.141Z"
}
```

Si el canal no existe o está vacío, `count` es `0`. Acepta `id` / `messageId` y los echoa en la respuesta. A diferencia de `list`, **no** requiere validación de firma porque solo expone un entero.

### Notificación de entrada al canal (`joined`)
Cuando un cliente hace `publish` exitoso en un canal, el servidor emite `joined` a todos los demás miembros publicados en ese canal:
```json
{
  "type": "joined",
  "token": "ABCD",
  "channel": "nombre-del-canal",
  "timestamp": "2026-05-01T12:00:00.000Z"
}
```

- El propio publicador **no** recibe este evento (recibe `published` como confirmación).
- Si el cliente re-publica en el mismo canal (ej. actualizando data), el servidor emite `joined` nuevamente — el receptor decide si lo trata como upsert o lo ignora.

### Notificación de salida del canal (`left`)
Cuando un cliente hace `unpublish` exitoso en un canal, el servidor emite `left` a los miembros restantes:
```json
{
  "type": "left",
  "token": "ABCD",
  "channel": "nombre-del-canal",
  "timestamp": "2026-05-01T12:00:00.000Z"
}
```

- El propio cliente que sale **no** recibe este evento (recibe `unpublished` como confirmación).
- Si el cliente cierra el WebSocket sin `unpublish`, **no** se emite `left`; en su lugar se emite `disconnected` (ver siguiente sección).

### Notificación de desconexión
Cuando un cliente se desconecta, el servidor emite el evento `disconnected` a:

1. **Cada miembro de cada canal** en el que el cliente desconectado estaba publicado. En ese caso el evento incluye el campo `channel`:
   ```json
   {
     "type": "disconnected",
     "token": "ABCD",
     "channel": "nombre-del-canal",
     "timestamp": "2026-03-01T04:33:38.141Z"
   }
   ```
   Si el cliente estaba publicado en N canales con receptores distintos, cada receptor recibe un evento por canal compartido (con su `channel` correspondiente).

2. **Pares emparejados que no fueron alcanzados por canal** (clientes con los que se intercambiaron mensajes pero sin canal en común). En este caso el evento **no** incluye `channel`:
   ```json
   {
     "type": "disconnected",
     "token": "ABCD",
     "timestamp": "2026-03-01T04:33:38.141Z"
   }
   ```

La desconexión manual vía `{type:"disconnect", target}` solo emite la forma sin `channel` a las dos partes del par, ya que se trata de cortar un par específico, no de cerrar la conexión completa.

### Errores
```json
{
  "type": "error",
  "error": "Mensaje de error descriptivo"
}
```

## Reglas del Sistema

### Tokens
- 4 caracteres alfanuméricos (1-9, A-Z)
- Asignados automáticamente al conectar
- Eliminados inmediatamente al desconectar
- No hay recuperación de conexión (nuevo token al reconectar)

### Mensajes
- El campo `to` puede ser un string (un destino) o array (múltiples destinos)
- No se pueden enviar mensajes a uno mismo
- Los mensajes fallan silenciosamente para destinos no encontrados
- Se registran pares de conexión para cada mensaje exitoso

### Pares de Conexión
- Se almacenan cuando un mensaje se entrega exitosamente
- Se usan solo para notificar desconexiones
- Se eliminan cuando uno de los clientes se desconecta

### Canales Públicos
- Cada cliente puede publicarse en un canal a la vez
- Máximo 100 tokens por canal (FIFO)
- Los tokens expiran después de 20 minutos
- Cualquier cliente puede listar tokens en cualquier canal

## Ejemplos de Uso

### JavaScript (Node.js)
```javascript
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:4001/');

ws.on('open', () => {
  console.log('Conectado');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  
  switch (msg.type) {
    case 'connected':
      console.log(`Token asignado: ${msg.token}`);
      break;
    case 'message':
      console.log(`Mensaje de ${msg.from}: ${msg.message}`);
      break;
    case 'disconnected':
      console.log(`Cliente ${msg.token} desconectado`);
      break;
  }
});

// Publicar en canal
ws.send(JSON.stringify({
  type: 'publish',
  channel: 'game-lobby'
}));

// Enviar mensaje
ws.send(JSON.stringify({
  to: ['ABCD', 'EFGH'],
  message: '¡Hola a todos!'
}));

// Desconectar manualmente de otro cliente
ws.send(JSON.stringify({
  type: 'disconnect',
  target: 'ABCD'
}));
```

## Limitaciones
- Máximo 100 tokens por canal
- Tokens expiran después de 20 minutos en canales
- No hay autenticación
- No hay cifrado (usar WSS en producción)
- No hay persistencia (todo en memoria)

## Iniciar Servidor
```bash
cd simple-websocket-proxy
npm install
node server.js
```

O con variables de entorno:
```bash
PORT=4002 node server.js
```

## Testing
```bash
node testSimple.js