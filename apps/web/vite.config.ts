import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// Ritara uses 5173 — keep Flowform on a separate port.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
  },
  preview: {
    port: 5181,
    strictPort: true,
  },
})
