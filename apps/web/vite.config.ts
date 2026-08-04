/// <reference types="vitest/config" />

import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
  plugins: [solidPlugin()],
  server: {
    host: "127.0.0.1",
    port: 4173,
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
