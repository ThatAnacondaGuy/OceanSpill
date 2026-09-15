import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // The map engine is large and changes rarely; keep it in its own cacheable chunk.
        manualChunks: { maplibre: ['maplibre-gl'] },
      },
    },
    chunkSizeWarningLimit: 1100,
  },
})
