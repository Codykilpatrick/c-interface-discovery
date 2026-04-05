import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    include: ['web-tree-sitter'],
  },
  worker: {
    format: 'es',
  },
  server: {
    headers: {
      // Required for SharedArrayBuffer / web-tree-sitter in some browsers
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
