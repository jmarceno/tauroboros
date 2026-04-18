import type { UserConfig } from "vite"
import react from "@vitejs/plugin-react"
import { resolve } from "path"

// Dev mode requires explicit backend port - dynamic port (0) not supported in dev mode
const SERVER_PORT = process.env.SERVER_PORT || "3789";
const DEV_PORT = process.env.DEV_PORT || "5174";

// Only check SERVER_PORT for dev mode (when not building)
const isDev = process.env.NODE_ENV !== "production" && !process.argv.includes("build");
if (isDev && (!SERVER_PORT || SERVER_PORT === "0")) {
  throw new Error(
    "Dev mode requires an explicit SERVER_PORT. " +
    "Run with: SERVER_PORT=3789 bun run dev"
  )
}

const config: UserConfig = {
  plugins: [react()],
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
            if (id.includes("react") || id.includes("react-dom")) {
              return "vendor-react"
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
      "/ws": {
        target: `ws://localhost:${SERVER_PORT}`,
        ws: true,
      },
    },
  },
};

export default config;
