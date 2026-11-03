import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Placeholder target: in dev nothing else listens on 4100, so proxied calls fail
// fast. In production the runtime serves the built shell itself.
const serverTarget = 'http://127.0.0.1:4100'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4100,
    strictPort: true,
    proxy: {
      '/api': { target: serverTarget },
      '/events': { target: serverTarget },
    },
  },
})
