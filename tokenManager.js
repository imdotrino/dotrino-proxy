// Token Manager para el sistema de tokens alfanuméricos cortos
// Caracteres permitidos: 1-9, A-Z (sin 0 ni letras minúsculas)
const ALLOWED_CHARS = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

class TokenManager {
    constructor() {
        // Mapa de tokens cortos activos: shortToken -> {ws, ip, lastActivity}
        this.activeTokens = new Map();
        // Longitud de los tokens cortos (4 caracteres)
        this.tokenLength = 4;
    }

    // Generar un token corto aleatorio de la longitud especificada
    generateRandomToken(length) {
        let token = '';
        for (let i = 0; i < length; i++) {
            const randomIndex = Math.floor(Math.random() * ALLOWED_CHARS.length);
            token += ALLOWED_CHARS[randomIndex];
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
        
        // Si no se encontró token único, aumentar longitud temporalmente
        const token = this.generateRandomToken(this.tokenLength + 1);
        console.log(`Aumentando longitud de token a ${this.tokenLength + 1} caracteres temporalmente`);
        return token;
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
    cleanupInactiveTokens(maxInactiveMinutes = 10) {
        const now = Date.now();
        const maxInactiveMs = maxInactiveMinutes * 60 * 1000;
        const inactiveTokens = [];
        
        for (const [token, info] of this.activeTokens) {
            if (now - info.lastActivity > maxInactiveMs) {
                inactiveTokens.push(token);
            }
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