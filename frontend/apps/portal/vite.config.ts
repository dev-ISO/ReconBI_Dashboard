import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Dev aliases point at package SOURCE for instant HMR; the packaged tarballs
// hosts consume are built separately via the ui package's lib-mode build.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@recon/dashboards-ui': fileURLToPath(
        new URL('../../packages/dashboards-ui/src/index.ts', import.meta.url),
      ),
      '@recon/dashboards-core': fileURLToPath(
        new URL('../../packages/dashboards-core/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5200,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:5040', changeOrigin: false },
    },
  },
  build: {
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        // Same chunk split the hosts will use — chunking issues surface here first.
        manualChunks(id: string) {
          if (id.includes('node_modules/recharts')) return 'rcd-charts';
          if (id.includes('node_modules/@xyflow')) return 'rcd-flow';
          if (
            id.includes('node_modules/react-grid-layout') ||
            id.includes('node_modules/react-resizable') ||
            id.includes('node_modules/react-draggable')
          ) {
            return 'rcd-grid';
          }
          return undefined;
        },
      },
    },
  },
});
