import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  // Served from a sub-path on GitHub Pages; CI sets BASE_PATH, local dev stays at the root.
  base: process.env.BASE_PATH ?? '/',
  build: { outDir: '../dist', emptyOutDir: true },
});
