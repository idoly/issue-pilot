/// <reference types="vitest/config" />

import { readFileSync } from "node:fs";

import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

const tlsPfx = process.env.ISSUE_PILOT_WEB_TLS_PFX;

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: "../../node_modules/.vite/issue-pilot-web",
  plugins: [solidPlugin()],
  server: {
    host: process.env.ISSUE_PILOT_WEB_HOST ?? "127.0.0.1",
    port: 4173,
    ...(tlsPfx ? { https: { pfx: readFileSync(tlsPfx), passphrase: process.env.ISSUE_PILOT_WEB_TLS_PASSPHRASE } } : {}),
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
