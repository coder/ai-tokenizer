import { defineConfig } from 'vite';

export default defineConfig({
  base: '/ai-tokenizer/',
  worker: {
    format: 'es'
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Split encodings into separate chunks for dynamic loading
          if (id.includes('encoding/cl100k_base')) {
            return 'encoding-cl100k';
          }
          if (id.includes('encoding/o200k_base')) {
            return 'encoding-o200k';
          }
          if (id.includes('encoding/p50k_base')) {
            return 'encoding-p50k';
          }
          if (id.includes('encoding/claude')) {
            return 'encoding-claude';
          }
        }
      }
    }
  }
});

