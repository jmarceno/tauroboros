import type { UserConfig } from "vite"
import solid from "vite-plugin-solid"
import { resolve } from "path"

class ViteConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ViteConfigError"
  }
}

// Dev mode requires explicit backend port - dynamic port (0) not supported in dev mode
const SERVER_PORT = process.env.SERVER_PORT || "3789"
const DEV_PORT = process.env.DEV_PORT || "5174"

// Only check SERVER_PORT for dev mode (when not building)
const isDev = process.env.NODE_ENV !== "production" && !process.argv.includes("build")
if (isDev && (!SERVER_PORT || SERVER_PORT === "0")) {
  throw new ViteConfigError(
    "Dev mode requires an explicit SERVER_PORT. " +
    "Run with: SERVER_PORT=3789 bun run dev"
  )
}

const config: UserConfig = {
  plugins: [solid()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes("node_modules")) {
            if (id.includes("solid-js")) {
              return "vendor-solid"
            }
            if (id.includes("fuse.js")) {
              return "vendor-fuse"
            }
            if (id.includes("@tiptap")) {
              return "vendor-tiptap"
            }
            if (id.includes("mermaid")) {
              return "vendor-mermaid"
            }
            if (id.includes("highlight.js")) {
              return "vendor-highlight"
            }
            if (id.includes("chart.js")) {
              return "vendor-chart"
            }
          }
        },
      },
    },
  },
  server: {
    port: parseInt(DEV_PORT, 10),
    proxy: {
      "/api": {
        target: `http://localhost:${SERVER_PORT}`,
        changeOrigin: true,
      },
      "/sse": {
        target: `http://localhost:${SERVER_PORT}`,
        changeOrigin: true,
      },
      "/ws": {
        target: `ws://localhost:${SERVER_PORT}`,
        ws: true,
      },
      "/console": {
        target: `ws://localhost:${SERVER_PORT}`,
        ws: true,
      },
    },
  },
}

export default config
