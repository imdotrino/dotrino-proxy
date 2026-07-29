// Token Manager para el sistema de tokens alfanuméricos cortos
// Caracteres permitidos: 1-9, A-Z (sin 0 ni letras minúsculas)
const crypto = require('crypto');

const ALLOWED_CHARS = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

class TokenManager {
    constructor() {
        // Mapa de tokens cortos activos: shortToken -> {ws, ip, lastActivity}
        this.activeTokens = new Map();
        // Longitud de los tokens cortos (4 caracteres)
        this.tokenLength = 4;
    }

    // Generar un token corto aleatorio de la longitud especificada.
    // Usa el CSPRNG del sistema (`crypto.randomInt`), NO `Math.random()`: el token
    // es un identificador que otros pueden intentar adivinar para escribirle a una
    // conexión ajena, y `Math.random()` es predecible a partir de unas pocas
    // muestras. `randomInt` además reparte uniforme sobre los 35 símbolos (rechaza
    // el sesgo del módulo), cosa que el `Math.floor(rand*35)` tampoco garantizaba.
    generateRandomToken(length) {
        let token = '';
        for (let i = 0; i < length; i++) {
            token += ALLOWED_CHARS[crypto.randomInt(ALLOWED_CHARS.length)];
        }
        return token;
    }

    // Verificar si un token corto ya está en uso
    isTokenInUse(token) {
        return this.activeTokens.has(token);
    }

    // Generar un token corto único
    generateUniqueToken() {
        let attempts = 0;
        const maxAttempts = 100;

        while (attempts < maxAttempts) {
            const token = this.generateRandomToken(this.tokenLength);

            if (!this.isTokenInUse(token)) {
                return token;
            }

            attempts++;
        }

        // Si no se encontró token único, aumentar longitud. La rama larga TAMBIÉN
        // comprueba unicidad: devolverlo a ciegas podía repetir un token ya vivo y
        // `activeConnections.set` sobrescribía la conexión previa en silencio (el
        // dueño del token viejo dejaba de recibir y nadie se enteraba).
        for (let len = this.tokenLength + 1; len <= this.tokenLength + 4; len++) {
            for (let i = 0; i < maxAttempts; i++) {
                const token = this.generateRandomToken(len);
                if (!this.isTokenInUse(token)) {
                    console.log(`Aumentando longitud de token a ${len} caracteres temporalmente`);
                    return token;
                }
            }
        }
        // Inalcanzable en la práctica (35^8 con el Map lleno); mejor fallar que
        // devolver un duplicado.
        throw new Error('No se pudo generar un token único');
    }

    // Asignar un token corto a una conexión
    assignToken(ws, ip) {
        const token = this.generateUniqueToken();
        const now = Date.now();
        
        this.activeTokens.set(token, {
            ws,
            ip,
            lastActivity: now,
            assignedAt: now
        });
        
        return token;
    }

    // Obtener información de un token corto activo
    getTokenInfo(token) {
        return this.activeTokens.get(token);
    }

    // Obtener WebSocket por token
    getWebSocket(token) {
        const info = this.activeTokens.get(token);
        return info ? info.ws : null;
    }

    // Verificar si un token corto es válido (existe)
    isValidToken(token) {
        return this.activeTokens.has(token);
    }

    // Actualizar la última actividad de un token corto
    updateTokenActivity(token) {
        const tokenInfo = this.activeTokens.get(token);
        if (tokenInfo) {
            tokenInfo.lastActivity = Date.now();
            return true;
        }
        return false;
    }

    // Liberar un token corto (cuando se desconecta) - INMEDIATO
    releaseToken(token) {
        if (this.activeTokens.has(token)) {
            this.activeTokens.delete(token);
            return true;
        }
        return false;
    }

    // Obtener todos los tokens cortos activos
    getAllActiveTokens() {
        return Array.from(this.activeTokens.keys());
    }

    // Obtener estadísticas
    getStats() {
        return {
            activeTokens: this.activeTokens.size,
            tokenLength: this.tokenLength
        };
    }

    // Limpiar tokens inactivos (por si acaso hay fugas)
    //
    // Solo recoge HUÉRFANOS: entradas cuyo socket ya no está abierto. Antes barría
    // por inactividad a secas y borraba de `activeTokens` un token cuya conexión
    // seguía viva; como `server.js` rutea por su propio `activeConnections` (que no
    // se tocaba), el token quedaba ruteable y a la vez libre para reasignar — dos
    // conexiones con el mismo token y el `close` de la vieja borrando a la nueva.
    // Un cliente sin heartbeat lo disparaba a los 10 minutos.
    cleanupInactiveTokens(maxInactiveMinutes = 10) {
        const now = Date.now();
        const maxInactiveMs = maxInactiveMinutes * 60 * 1000;
        const inactiveTokens = [];

        for (const [token, info] of this.activeTokens) {
            if (now - info.lastActivity <= maxInactiveMs) continue;
            // OPEN(1) o CONNECTING(0): la conexión sigue en pie, no es un huérfano.
            const state = info.ws && info.ws.readyState;
            if (state === 0 || state === 1) continue;
            inactiveTokens.push(token);
        }
        
        // Liberar tokens inactivos
        inactiveTokens.forEach(token => {
            console.log(`Liberando token inactivo: ${token} (inactivo por ${Math.floor((now - this.activeTokens.get(token).lastActivity) / 60000)} minutos)`);
            this.activeTokens.delete(token);
        });

        return inactiveTokens.length;
    }

    // Iniciar intervalo de limpieza periódica (solo para tokens huérfanos)
    // Devuelve el handle del interval para que el llamador pueda limpiarlo (clearInterval).
    startCleanupInterval(intervalMinutes = 5) {
        return setInterval(() => {
            const cleaned = this.cleanupInactiveTokens();
            if (cleaned > 0) {
                console.log(`Limpieza automática: ${cleaned} tokens inactivos removidos`);
            }
        }, intervalMinutes * 60 * 1000);
    }
}

module.exports = new TokenManager();