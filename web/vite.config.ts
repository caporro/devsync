import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

const apiProxyTarget = process.env.DEVSYNC_API_PROXY_TARGET || "http://127.0.0.1:4000"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined
          }

          if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/scheduler/")) {
            return "vendor-react"
          }

          if (id.includes("@tanstack")) {
            return "vendor-query"
          }

          if (id.includes("@hugeicons")) {
            return "vendor-icons"
          }

          if (id.includes("radix-ui") || id.includes("@radix-ui")) {
            return "vendor-ui"
          }

          return undefined
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
  },
  server: {
    host: "127.0.0.1",
    watch: process.env.DEVSYNC_WEB_POLLING === "true" ? { usePolling: true, interval: 250 } : undefined,
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: false,
      },
      "/mcp": {
        target: apiProxyTarget,
        changeOrigin: false,
      },
    },
  },
})
