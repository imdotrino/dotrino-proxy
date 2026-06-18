# Ejemplo de Formato de Canal Actualizado

## Formato Requerido

El canal ahora debe seguir este formato:

```json
{
  "data": {
    "name": "nombre-del-canal",
    "publickey": "clave-publica-del-cliente",
    "otrosDatos": "opcionales"
  },
  "signature": "firma-base64-de-los-datos"
}
```

## Ejemplo de Uso

### Publicar en un canal:

```json
{
  "type": "publish",
  "channel": {
    "data": {
      "name": "chess-lobby",
      "publickey": "MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAKj34GkxFhD90vcNvL4x7FDm6q4f4aBc",
      "description": "Sala de ajedrez pública",
      "maxPlayers": 2
    },
    "signature": "MEUCIQCy4Vh5ZKpZVwLcQhXwLcQhXwLcQhXwLcQhXwLcQhXwIgYg=="
  }
}
```

### Despublicar de un canal:

```json
{
  "type": "unpublish",
  "channel": {
    "data": {
      "name": "chess-lobby",
      "publickey": "MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAKj34GkxFhD90vcNvL4x7FDm6q4f4aBc"
    },
    "signature": "MEUCIQCy4Vh5ZKpZVwLcQhXwLcQhXwLcQhXwLcQhXwLcQhXwIgYg=="
  }
}
```

### Listar tokens en un canal:

```json
{
  "type": "list",
  "channel": {
    "data": {
      "name": "chess-lobby",
      "publickey": "MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAKj34GkxFhD90vcNvL4x7FDm6q4f4aBc"
    },
    "signature": "MEUCIQCy4Vh5ZKpZVwLcQhXwLcQhXwLcQhXwLcQhXwLcQhXwIgYg=="
  }
}
```

## Validaciones Implementadas

1. **Estructura**: Debe tener `data` (objeto) y `signature` (string)
2. **Campos requeridos en data**: `name` (string) y `publickey` (string)
3. **Límite de caracteres**: El JSON completo no debe exceder 1000 caracteres
4. **Firma**: Debe ser un string no vacío con formato base64 válido

## Notas

- La firma es validada básicamente (formato base64, no vacía)
- En producción, implementar verificación criptográfica real usando `crypto.verify()`
- El campo `publickey` debe contener la clave pública en formato PEM o similar
- Otros campos en `data` son opcionales y pueden ser cualquier JSON válido