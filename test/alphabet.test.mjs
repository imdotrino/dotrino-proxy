import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { ALPHABET, CONFUSABLES, normalize, isEmittable, isUnfortunate } = require('../alphabet');
const { PairingCodes } = require('../pairingCodes');
const { deriveNodeId, isValidNodeId } = require('../nodeIdentity');

describe('alfabeto sin confundibles', () => {
    // LA regla del diseño. Mapear un carácter que TAMBIÉN se emite sería peor que
    // no mapear nada: quien lee una `S` de verdad en la pantalla y la teclea
    // obtendría un `5`, y su código correcto pasaría a ser inválido.
    it('ningún carácter mapeado se emite jamás', () => {
        for (const origen of Object.keys(CONFUSABLES)) {
            if (CONFUSABLES[origen] === origen) continue;   // O→O es identidad
            expect(ALPHABET.includes(origen)).toBe(false);
        }
    });

    it('todo destino del mapeo SÍ es emitible', () => {
        for (const destino of Object.values(CONFUSABLES)) {
            expect(ALPHABET.includes(destino)).toBe(true);
        }
    });

    it('no emite los pares visuales conflictivos', () => {
        for (const c of ['I', 'L', 'S', 'Z', 'B', 'G', '0']) {
            expect(ALPHABET.includes(c)).toBe(false);
        }
    });

    it('conserva el dígito de cada par (más rápido de dictar, sin ambigüedad de nombre)', () => {
        for (const c of ['1', '5', '2', '8', '6']) expect(ALPHABET.includes(c)).toBe(true);
    });

    // Efecto colateral buscado: al salir la B desaparece el B/V, que es la
    // confusión hablada más fuerte del español.
    it('al salir la B se resuelve el B/V del español hablado', () => {
        expect(ALPHABET.includes('B')).toBe(false);
        expect(ALPHABET.includes('V')).toBe(true);
    });

    it('no tiene símbolos repetidos', () => {
        expect(new Set(ALPHABET).size).toBe(ALPHABET.length);
    });

    describe('normalize', () => {
        it('pasa a mayúsculas y quita separadores', () => {
            expect(normalize('k7m-2q9')).toBe('K7M2Q9');
            expect(normalize('  K7 M2 Q9  ')).toBe('K7M2Q9');
            expect(normalize('K7M_2Q9')).toBe('K7M2Q9');
        });

        it('traduce los confundibles: quien oye "ese" y teclea S obtiene el 5', () => {
            expect(normalize('S')).toBe('5');
            expect(normalize('I')).toBe('1');
            expect(normalize('l')).toBe('1');
            expect(normalize('Z')).toBe('2');
            expect(normalize('B')).toBe('8');
            expect(normalize('G')).toBe('6');
        });

        it('el 0 tecleado se entiende como la letra O (el 0 no se emite)', () => {
            expect(normalize('0')).toBe('O');
            expect(normalize('O')).toBe('O');
        });

        it('deja intacto lo que sí se emite', () => {
            expect(normalize(ALPHABET)).toBe(ALPHABET);
        });

        it('es idempotente: normalizar dos veces da lo mismo', () => {
            for (const s of ['sIlBoZ', 'K7M2Q9', '0OIL58', ALPHABET]) {
                expect(normalize(normalize(s))).toBe(normalize(s));
            }
        });

        it('devuelve null ante basura', () => {
            expect(normalize('')).toBeNull();
            expect(normalize('   ')).toBeNull();
            expect(normalize(null)).toBeNull();
            expect(normalize(42)).toBeNull();
        });
    });

    describe('un código mal dictado se recupera', () => {
        it('escrito con TODAS las letras confundibles llega al mismo código', () => {
            const codes = new PairingCodes();
            // Se fuerza un cuerpo con dígitos confundibles para probar el camino.
            const { code } = codes.create({ instance: 'inst-1', hint: ALPHABET.slice(0, 2) });
            const maldictado = [...code].map((c) => ({ 1: 'I', 5: 'S', 2: 'Z', 8: 'B', 6: 'G' }[c] || c)).join('');
            expect(codes.redeem(maldictado).instance).toBe('inst-1');
        });
    });
});

describe('palabras desafortunadas', () => {
    it('las detecta', () => {
        expect(isUnfortunate('PUTA')).toBe(true);
        expect(isUnfortunate('xxCACAxx')).toBe(true);
        expect(isUnfortunate('K7M2')).toBe(false);
    });

    it('el sorteo no emite una cita que las contenga', () => {
        const codes = new PairingCodes();
        for (let i = 0; i < 300; i++) {
            const { code } = codes.create({ instance: `i-${i}`, hint: 'K7' });
            expect(isUnfortunate(code)).toBe(false);
        }
    });
});

describe('el id de nodo usa el mismo alfabeto', () => {
    it('un id derivado solo trae símbolos emitibles', () => {
        const crypto = require('crypto');
        for (let i = 0; i < 20; i++) {
            const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
            const id = deriveNodeId(JSON.stringify(kp.publicKey.export({ format: 'jwk' })));
            expect(isValidNodeId(id)).toBe(true);
            expect(isEmittable(id)).toBe(true);
        }
    });
});

// Los dos siguientes salieron de un barrido adversarial del propio módulo.
describe('regresiones del normalizador y del filtro', () => {
    it('descarta CUALQUIER espacio en blanco, no una lista cerrada', () => {
        // Un código pegado del portapapeles suele traer un salto de línea al
        // final; con una lista de tres separadores eso lo volvía inválido sin
        // que se entendiera por qué.
        expect(normalize('K7M2Q9\n')).toBe('K7M2Q9');
        expect(normalize('K7M2Q9\r\n')).toBe('K7M2Q9');
        expect(normalize('K7 M2\tQ9')).toBe('K7M2Q9');
        expect(normalize(' K7M2Q9')).toBe('K7M2Q9');
    });

    it('el filtro mira el código COMPLETO, no solo el cuerpo', () => {
        // Con el filtro de nodo `PU` y el cuerpo `TAXX` sale `PUTAXX`: mirando
        // solo el cuerpo, eso pasaba limpio.
        const codes = new PairingCodes();
        for (let i = 0; i < 500; i++) {
            const { code } = codes.create({ instance: `i-${i}`, hint: 'PU' });
            expect(isUnfortunate(code)).toBe(false);
        }
    });
});
