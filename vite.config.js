import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const developmentDataOrigin = (process.env.VENN_FIRE_DEV_DATA_ORIGIN || 'https://venn-fire.vercel.app')
  .replace(/\/$/, '')

export default defineConfig({
  plugins: [react()],
  // Vite does not run the Vercel functions. Proxy only the read-only database
  // view in development so `pnpm dev` works without production credentials.
  // No refresh, ingestion or other mutating route is proxied.
  server: {
    proxy: {
      '/api/data': {
        target: developmentDataOrigin,
        changeOrigin: true,
        secure: true,
      },
    },
  },
})
