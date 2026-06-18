import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['test/**/*.test.{js,mjs}'],
        testTimeout: 5000,
        hookTimeout: 10000,
        // Cada archivo de test arranca su propia instancia de servidor en un puerto OS-asignado.
        // Forzamos pool de forks para aislar el estado a nivel módulo entre archivos.
        pool: 'forks',
        poolOptions: {
            forks: { singleFork: false }
        }
    }
});
