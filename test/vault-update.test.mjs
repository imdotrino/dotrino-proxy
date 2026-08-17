/**
 * Qué hace el proxio con lo que le dice la bóveda (`vaultSecrets.handleVaultUpdate`).
 *
 * Es una decisión de SEGURIDAD, no de comodidad: una variable se rota casi siempre
 * porque se filtró, y mientras el proceso siga vivo el valor viejo sigue en su memoria
 * (en JS un string no se puede borrar) y sigue siendo el que usa. Por eso el aviso de
 * cambio termina el proceso y lo levanta su supervisor.
 *
 * Lo que hace distinto al proxio es el ARRANQUE —sirve sin haber recibido nunca las
 * variables del vault—, no esto.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { handleVaultUpdate } = require('../vaultSecrets');

describe('aviso de la bóveda', () => {
    it('configuración nueva → se REINICIA (sale limpio para que lo levante el supervisor)', async () => {
        vi.useFakeTimers();
        const exit = vi.fn();
        const pendings = [];
        const decision = handleVaultUpdate(
            { reason: 'changed', ts: 1_700_000_000_000 },
            { log: () => {}, onPending: (p) => pendings.push(p), exit, exitDelayMs: 300 }
        );

        expect(decision).toBe('restart');
        // Queda anotado ANTES de morir: es lo que `GET /peers` enseña mientras vuelve.
        expect(pendings).toEqual([{ reason: 'changed', ts: 1_700_000_000_000 }]);
        // No sale en seco: si no, el log que explica por qué murió se pierde en la tubería.
        expect(exit).not.toHaveBeenCalled();
        vi.advanceTimersByTime(300);
        expect(exit).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });

    it('cambio encontrado al COMPARAR (nadie avisó) → se reinicia igual, y se dice', async () => {
        // El agente no solo escucha: al conectar compara su configuración con la de la
        // bóveda. Es lo que salva al proxio que estuvo incomunicado, que es precisamente
        // el que no recibe avisos.
        vi.useFakeTimers();
        const exit = vi.fn();
        const lines = [];
        const decision = handleVaultUpdate(
            { reason: 'changed', ts: 2, via: 'reconcile' },
            { log: (m) => lines.push(m), exit, exitDelayMs: 300 }
        );

        expect(decision).toBe('restart');
        expect(lines.some((l) => /nadie avisó/.test(l))).toBe(true);
        vi.advanceTimersByTime(300);
        expect(exit).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });

    it('revocado → NO se reinicia: sigue transportando, que no necesita al vault', () => {
        const exit = vi.fn();
        const pendings = [];
        const decision = handleVaultUpdate(
            { reason: 'revoked', ts: 1 },
            { log: () => {}, onPending: (p) => pendings.push(p), exit }
        );

        // Salir apagaría el transporte de todos sin arreglar nada: al volver seguiría
        // revocado, y el bucle sería infinito.
        expect(decision).toBe('stay');
        expect(exit).not.toHaveBeenCalled();
        expect(pendings).toEqual([{ reason: 'revoked', ts: 1 }]);
    });
});
