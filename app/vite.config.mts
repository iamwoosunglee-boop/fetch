import { defineConfig } from 'vitest/config';

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist/renderer',
    rollupOptions: { input: { app: 'index.html', indexing: 'indexing.html' } },
  },
  server: { host: '127.0.0.1', headers },
  preview: { host: '127.0.0.1', headers },
  test: { include: ['src/**/*.test.ts'], maxWorkers: 1 },
});
