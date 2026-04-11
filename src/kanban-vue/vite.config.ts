import type { UserConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

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
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3789',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3789',
        ws: true,
      },
    },
  },
}

export default config
