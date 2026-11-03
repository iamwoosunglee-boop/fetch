import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  publicDir: false,
  build: { outDir: 'dist/web', rollupOptions: { input: 'index.html' } },
});
