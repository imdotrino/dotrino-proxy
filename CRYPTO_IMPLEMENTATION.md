# Implementación Criptográfica para Formato de Canal

## Resumen

Se ha implementado un sistema criptográfico real para el nuevo formato de canal:

```
{
  data: {
    name: "channelName",
    publickey: "clave-publica-en-formato-JWK",
    ...otrosDatos
  },
  signature: "firma-base64"
}
```

## Cliente (WebSocketProxyClient)

### Generación de Claves
1. **Al inicializar**: Genera un par de claves ECDSA P-256 usando Web Crypto API
2. **Almacenamiento**: Guarda las claves en localStorage bajo la clave `websocket_proxy_crypto_keys`
3. **Persistencia**: Las mismas claves se reutilizan en futuras sesiones
4. **Formato**: Claves almacenadas como JWK (JSON Web Key)

### Firma de Datos
1. **Algoritmo**: ECDSA con curva P-256 y hash SHA-256
2. **Proceso**:
   - Convierte los datos del canal a string JSON
   - Firma con la clave privada usando Web Crypto API
   - Codifica la firma a base64
3. **Fallback**: Si Web Crypto API no está disponible, genera firma mock

### Métodos Actualizados
- `publish(channel, extraData)`: Firma automáticamente los datos
- `unpublish(channel)`: Firma para despublicar
- `listChannel(channel)`: Firma para listar canales
- `createChannelObject()`: Crea objeto de canal con firma

## Servidor (server.js)

### Validación de Firmas
1. **Recepción**: Recibe clave pública como JWK string
2. **Análisis**: Detecta si la clave es JWK ECDSA P-256
3. **Verificación**:
   - Convierte JWK a formato raw (0x04 + x + y)
   - Usa Node.js crypto para verificar firma ECDSA
   - Valida contra hash SHA-256 de los datos
4. **Fallback**: Validación básica para desarrollo (acepta firmas mock)

### Validaciones
1. **Estructura**: Campos `data` y `signature` requeridos
2. **Formato**: Firma debe ser base64 válido
3. **Longitud**: JSON completo ≤ 1000 caracteres
4. **Campos**: `data.name` y `data.publickey` requeridos

## Flujo de Trabajo

### Publicar en Canal
```
Cliente:
1. Carga/Genera claves desde localStorage
2. Crea objeto de datos del canal
3. Firma datos con clave privada
4. Envía {data, signature} al servidor

Servidor:
1. Valida estructura y longitud
2. Parsea clave pública JWK
3. Verifica firma ECDSA
4. Si válido, publica en canal
```

### Compatibilidad
- **Backward**: Acepta strings de canal (convierte a nuevo formato)
- **Fallback**: Funciona sin Web Crypto API (firmas mock)
- **Desarrollo**: Acepta firmas mock para testing

## Consideraciones de Seguridad

### Producción
1. **Almacenamiento**: localStorage es vulnerable a XSS, considerar opciones más seguras
2. **Rotación**: Implementar rotación periódica de claves
3. **Validación**: Servidor debe rechazar firmas mock en producción
4. **Transporte**: Considerar HTTPS/WSS para proteger claves en tránsito

### Mejoras Futuras
1. **Certificados**: Usar certificados X.509 en lugar de JWK
2. **ACL**: Control de acceso basado en claves públicas
3. **Revocación**: Mecanismo para revocar claves comprometidas
4. **Auditoría**: Log de operaciones firmadas

## Ejemplo de JWK ECDSA P-256
```json
{
  "kty": "EC",
  "crv": "P-256",
  "x": "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
  "y": "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
  "ext": true
}
```

## Testing
Para testing/desarrollo, el sistema acepta:
- Firmas que comienzan con `FALLBACK-` o `MOCK-`
- Claves públicas en formato simple (no JWK)
- Validación básica sin verificación criptográfica