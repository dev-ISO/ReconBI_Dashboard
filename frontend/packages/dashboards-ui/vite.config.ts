import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';

// Library build: ship only our own code. Every runtime dependency is external so
// the consuming app (host SPA or portal) resolves and chunks them itself.
// preserveModules keeps internal React.lazy() boundaries intact for host-side
// code splitting and tree-shaking.
export default defineConfig({
  plugins: [react(), dts({ rollupTypes: false, tsconfigPath: './tsconfig.json' })],
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      cssFileName: 'style',
    },
    cssCodeSplit: false,
    sourcemap: true,
    rollupOptions: {
      external: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react-dom/client',
        'zustand',
        'zustand/vanilla',
        'zustand/react',
        '@recon/dashboards-core',
        'recharts',
        '@xyflow/react',
        'react-grid-layout',
        'react-resizable',
        'react-draggable',
        '@dnd-kit/core',
        '@dnd-kit/sortable',
        '@dnd-kit/utilities',
        'lucide-react',
      ],
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
        entryFileNames: '[name].js',
      },
    },
  },
});
