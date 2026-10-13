import { defineConfig } from 'vite';

// Single-page game. Daily puzzles live in public/daily and are fetched lazily;
// chapters are separate chunks through dynamic import().
export default defineConfig({
    base: '/',
    build: {
        outDir: 'dist',
        target: 'es2020',
        sourcemap: false,
        assetsInlineLimit: 0,
        chunkSizeWarningLimit: 400,
    },
    worker: {
        format: 'es',
    },
    server: {
        host: true,
    },
});
