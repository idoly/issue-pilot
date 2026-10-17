/// <reference types="vitest/config" />

import path from "node:path";
import { createReadStream, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { defineConfig, type Plugin } from "vite";
import solidPlugin from "@solidjs/vite-plugin";
import { issuePilotConfig } from "../../issue-pilot.config.ts";

const require = createRequire(import.meta.url);
const materialRoot = path.dirname(require.resolve("material-icon-theme/package.json"));
const materialVersion = (require("material-icon-theme/package.json") as { version: string }).version;
const iconRoot = path.join(materialRoot, "icons");
const iconFiles = readdirSync(iconRoot).filter(name => name.endsWith(".svg"));
const iconNames = new Set(iconFiles);
const iconPrefix = `assets/editor-icons-${materialVersion}/`;
const iconLicenses = `Material Icon Theme — https://github.com/material-extensions/vscode-material-icon-theme\n${readFileSync(path.join(materialRoot, "LICENSE"), "utf8")}\n\nCodicons © Microsoft Corporation — https://github.com/microsoft/vscode-codicons\nOriginal icon font, licensed under CC BY 4.0. The editor uses the unchanged font distributed in @codingame/monaco-vscode-api 36.2.7, from https://github.com/microsoft/vscode/tree/main/src/vs/base/browser/ui/codicons; the matching icon names and code points are kept with the font.\n${readFileSync(path.resolve("src/web/src/app/editor-codicons.LICENSE"), "utf8")}`;

function editorIconAssets(): Plugin {
  return {
    name: "editor-icon-assets",
    configureServer(server) {
      server.middlewares.use("/assets/editor-icon-licenses.txt", (_request, response) => { response.setHeader("Content-Type", "text/plain; charset=utf-8"); response.end(iconLicenses); });
      server.middlewares.use(`/${iconPrefix}`, (request, response, next) => {
        let name: string;
        try { name = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname.slice(1)); } catch { return next(); }
        if (!iconNames.has(name)) return next();
        response.setHeader("Content-Type", "image/svg+xml");
        createReadStream(path.join(iconRoot, name)).on("error", next).pipe(response);
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "assets/editor-icon-licenses.txt", source: iconLicenses });
      for (const name of iconFiles) this.emitFile({ type: "asset", fileName: iconPrefix + name, source: readFileSync(path.join(iconRoot, name)) });
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: "../../node_modules/.vite/issue-pilot-web",
  plugins: [editorIconAssets(), solidPlugin()],
  server: {
    host: issuePilotConfig.web.host,
    port: issuePilotConfig.web.port,
    watch: { awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 20 } },
    proxy: {
      "/mcp": { target: `http://127.0.0.1:${issuePilotConfig.http.port}` },
      "/api": { target: `http://127.0.0.1:${issuePilotConfig.http.port}`, ws: true },
    },
  },
  test: { setupFiles: ["./src/test-setup.ts"] },
  build: { target: "es2022", rollupOptions: { input: path.join(import.meta.dirname, "index.html") } },
});
