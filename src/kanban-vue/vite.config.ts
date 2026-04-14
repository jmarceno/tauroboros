import type { UserConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// Dev mode requires explicit backend port - dynamic port (0) not supported in dev mode
const SERVER_PORT = process.env.SERVER_PORT
const DEV_PORT = process.env.DEV_PORT || '5173'

if (!SERVER_PORT || SERVER_PORT === '0') {
  throw new Error(
    'Dev mode requires an explicit SERVER_PORT. ' +
    'Run with: SERVER_PORT=3789 bun run dev'
  )
}

const config: UserConfig = {
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor': ['vue', 'fuse.js', 'radix-vue'],
        },
      },
    },
  },
  server: {
    port: parseInt(DEV_PORT, 10),
    proxy: {
      '/api': {
        target: `http://localhost:${SERVER_PORT}`,
        changeOrigin: true,
      },
      '/ws': {
        target: `ws://localhost:${SERVER_PORT}`,
        ws: true,
      },
    },
  },
}

export default config
