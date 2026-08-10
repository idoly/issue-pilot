/// <reference types="vitest/config" />

import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

import { issuePilotConfig } from "../../issue-pilot.config.ts";

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: "../../node_modules/.vite/issue-pilot-web",
  plugins: [solidPlugin()],
  server: {
    host: issuePilotConfig.web.host,
    port: issuePilotConfig.web.port,
    watch: {
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 20 },
    },
    proxy: {
      "/api": { target: `http://${issuePilotConfig.http.host}:${issuePilotConfig.http.port}`, ws: true },
      "/code-server": {
        target: `http://${issuePilotConfig.runtime.codeServer.listenHost}:${issuePilotConfig.runtime.codeServer.listenPort}`,
        ws: true,
        rewrite: (requestPath) => requestPath.replace(/^\/code-server/, "") || "/",
      },
    },
  },
  test: { setupFiles: ["./src/test-setup.ts"] },
  build: { target: "es2022" },
});
