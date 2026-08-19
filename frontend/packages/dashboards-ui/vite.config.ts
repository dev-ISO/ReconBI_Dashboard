import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';

// Library build: ship only our own code. Every runtime dependency is external so
// the consuming app (host SPA or portal) resolves and chunks them itself.
// ONE deliberate exception: html-to-image (the tile→PNG rasterizer) is a tiny
// zero-dependency devDep left OFF the external list so it is BUNDLED into the
// dist — consumers get the image-export feature without a new dependency of
// their own. preserveModules keeps internal React.lazy() boundaries intact for
// host-side code splitting and tree-shaking.
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
