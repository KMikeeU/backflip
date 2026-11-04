import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs so the bundle works when served from the app:// protocol in Electron.
  base: './',
  build: { target: 'es2023', chunkSizeWarningLimit: 4000 },
  worker: { format: 'es' },
});
