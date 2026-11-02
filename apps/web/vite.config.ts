import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const control = process.env.MEC_CONTROL_URL ?? 'http://127.0.0.1:4100'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': control, '/auth': control },
  },
  build: { outDir: 'dist', sourcemap: true },
})
