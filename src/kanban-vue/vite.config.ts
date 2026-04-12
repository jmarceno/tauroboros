import type { UserConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// Dynamic port configuration - allows multiple instances
// Port 0 means auto-assign available port
const SERVER_PORT = process.env.SERVER_PORT || '3789'
const DEV_PORT = process.env.DEV_PORT || '5173'

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
