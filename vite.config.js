import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const API_PORT = process.env.PORT || 8081

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1200 },
})