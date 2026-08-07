/// <reference types="vitest/config" />

import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: "../../node_modules/.vite/issue-pilot-web",
  plugins: [solidPlugin()],
  server: {
    host: "127.0.0.1",
    port: 4173,
    watch: {
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 20 },
    },
    proxy: {
      "/api": { target: "http://127.0.0.1:3000", ws: true },
      "/code-server": {
        target: "http://127.0.0.1:18080",
        ws: true,
        rewrite: (requestPath) => requestPath.replace(/^\/code-server/, "") || "/",
      },
    },
  },
  test: { setupFiles: ["./src/test-setup.ts"] },
  build: { target: "es2022" },
});
