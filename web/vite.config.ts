import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Keeps the browser on a single origin in dev; no CORS juggling.
      '/api': { target: 'http://localhost:5174', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
