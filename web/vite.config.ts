import { defineConfig } from 'vite';

// Relative base so the build works from any sub-path (GitHub Pages, claude.ai artifacts, Vercel).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    modulePreload: { polyfill: false },
  },
  worker: { format: 'es' },
  server: { host: true, port: 5173 },
});
