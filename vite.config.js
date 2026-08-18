import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const developmentDataOrigin = (process.env.VENN_FIRE_DEV_DATA_ORIGIN || 'https://venn-fire.vercel.app')
  .replace(/\/$/, '')

export default defineConfig({
  plugins: [react()],
  // Vite does not run the Vercel functions. Proxy only the read-only database
  // and stored-image views in development so the normal and news presentations
  // work without production credentials. No mutating route is proxied.
  server: {
    proxy: {
      '/api/data': {
        target: developmentDataOrigin,
        changeOrigin: true,
        secure: true,
      },
      '/api/source-image': {
        target: developmentDataOrigin,
        changeOrigin: true,
        secure: true,
      },
      '/api/sentinel-quicklook': {
        target: developmentDataOrigin,
        changeOrigin: true,
        secure: true,
      },
    },
  },
})
