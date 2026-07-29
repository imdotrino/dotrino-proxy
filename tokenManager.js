// Identificadores de CONEXIÓN ("instancias").
//
// Hasta la fase 4 esto emitía un código de 4 caracteres que hacía dos trabajos a
// la vez: era la dirección con la que se ruteaba un mensaje Y el código que un
// humano leía o tecleaba para emparejarse. Esa doble función es la que rompía el
// ecosistema al haber varios proxios:
//
//   - como dirección, 4 caracteres no alcanzan para un espacio GLOBAL (unas
//     700.000 combinaciones, y cada nodo sorteaba sin hablar con los demás → el
//     mismo código podía estar vivo en dos nodos a la vez, y un mensaje ruteado
//     globalmente se podía entregar a la persona equivocada);
//   - como código humano, no podía crecer sin volverse incómodo de dictar.
//
// Ahora son dos cosas distintas. Acá vive la primera: la INSTANCIA, que nunca la
// ve una persona, así que puede ser todo lo larga que haga falta. Lleva delante
// el ID DEL NODO que la emitió, con lo cual:
//   - es única en todo el ecosistema POR CONSTRUCCIÓN (no por probabilidad);
//   - se rutea leyéndola: el id dice a qué nodo hay que mandarle el mensaje, sin
//     preguntarle a nadie ni mantener un registro global.
//
// Este módulo ya NO depende del alfabeto: las instancias son bytes al azar en
// base64url y el id de nodo lo calcula nodeIdentity. Tenía una copia de
// ALLOWED_CHARS y un generador de códigos de 4 caracteres que quedó sin usar.
// El código corto para humanos (la "cita") vive aparte, en pairingCodes.js.
const crypto = require('crypto');

// 16 bytes = 128 bits en base64url (22 caracteres). Adivinar una instancia ajena
// no es un objetivo realista, que es justo lo que no podía decirse de 4 chars.
const INSTANCE_BYTES = 16;

class TokenManager {
    constructor() {
        // Mapa de instancias activas: instance -> {ws, ip, lastActivity}
        this.activeTokens = new Map();
        // Id del nodo (12 caracteres, derivado de su llave). Lo fija server.js al
        // arrancar. Sin él las instancias no son ruteables entre nodos.
        this.nodeId = null;
    }

    /** Fija el id de nodo que llevarán las instancias emitidas. */
    setNodeId(nodeId) {
        this.nodeId = nodeId || null;
    }

    /**
     * Genera una instancia: `<id de nodo><22 chars base64url>`.
     *
     * El id va delante para que rutearla sea LEERLA: quien la recibe sabe a qué
     * proxio mandarla sin preguntarle a nadie ni mantener ninguna tabla. Y como
     * el id se deriva de la llave del nodo, la instancia es única en todo el
     * ecosistema por construcción, sin que nadie tenga que repartir nada.
     *
     * Sin identidad de nodo usa `??` de relleno: no rutea a ninguna parte, pero
     * mantiene el formato y el nodo suelto sigue funcionando solo.
     */
    generateInstance() {
        const id = this.nodeId || '??';
        return id + crypto.randomBytes(INSTANCE_BYTES).toString('base64url');
    }


    // Verificar si un token corto ya está en uso
    isTokenInUse(token) {
        return this.activeTokens.has(token);
    }

    /**
     * Genera una instancia libre. Con 128 bits de azar el bucle es una
     * formalidad, pero se comprueba igual: la versión anterior devolvía a ciegas
     * un token más largo si los 100 intentos chocaban, y ese token podía repetir
     * uno ya vivo — `activeConnections.set` sobrescribía la conexión previa en
     * silencio y su dueño dejaba de recibir sin enterarse.
     */
    generateUniqueToken() {
        for (let i = 0; i < 10; i++) {
            const instance = this.generateInstance();
            if (!this.isTokenInUse(instance)) return instance;
        }
        throw new Error('No se pudo generar una instancia única');
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