/// <reference types="vitest/config" />

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { defineConfig, type Plugin } from "vite";
import solidPlugin from "vite-plugin-solid";

import { issuePilotConfig } from "../../issue-pilot.config.ts";

const require = createRequire(import.meta.url);
const githubMarkdownDirectory = path.dirname(require.resolve("github-markdown-css/package.json"));
const markdownFeaturesDirectory = path.dirname(require.resolve("@codingame/monaco-vscode-markdown-language-features-default-extension/package.json"));
const markdownPreviewCss = [
  fs.readFileSync(path.join(githubMarkdownDirectory, "github-markdown-dark.css"), "utf8"),
  fs.readFileSync(path.join(markdownFeaturesDirectory, "resources/highlight.css.txt"), "utf8"),
  "html,body{margin:0;background:#0d1117;color:#e6edf3;color-scheme:dark}body{box-sizing:border-box;padding:24px 32px}.markdown-body{max-width:none;background:transparent;color:#e6edf3}",
].join("\n");
const githubThemeJson = fs.readFileSync(path.join(import.meta.dirname, "src", "vscode", "github-dark-default.json"), "utf8");
const githubThemeUrl = `data:application/json;base64,${Buffer.from(githubThemeJson).toString("base64")}`;
const materialThemeDirectory = path.dirname(require.resolve("material-icon-theme/package.json"));
const materialThemeManifest = require(path.join(materialThemeDirectory, "package.json")) as Record<string, unknown>;
const materialIconsPath = path.join(materialThemeDirectory, "dist/material-icons.json");
const materialIcons = require(materialIconsPath) as { iconDefinitions: Record<string, { iconPath: string }> };
const materialIconPaths = [...new Set(Object.values(materialIcons.iconDefinitions).map(({ iconPath }) => iconPath))].map((iconPath) => {
  const absolutePath = path.resolve(path.dirname(materialIconsPath), iconPath);
  if (!absolutePath.startsWith(`${materialThemeDirectory}${path.sep}`)) throw new Error(`material_icon_path_outside_package:${iconPath}`);
  return { extensionPath: path.relative(materialThemeDirectory, absolutePath).replaceAll(path.sep, "/"), absolutePath };
});
const githubThemeModule = "virtual:issue-pilot-github-dark-default";
const materialThemeModule = "virtual:issue-pilot-material-icon-theme";
const markdownStyleModule = "virtual:issue-pilot-markdown-preview-style";
const resolvedGithubThemeModule = `\0${githubThemeModule}`;
const resolvedMaterialThemeModule = `\0${materialThemeModule}`;
const resolvedMarkdownStyleModule = `\0${markdownStyleModule}`;

function githubThemePlugin(): Plugin {
  return {
    name: "issue-pilot-github-theme",
    resolveId(id) {
      return id === githubThemeModule ? resolvedGithubThemeModule : undefined;
    },
    load(id) {
      if (id !== resolvedGithubThemeModule) return undefined;
      const manifest = {
        name: "issue-pilot-github-dark-default",
        publisher: "issue-pilot",
        version: "1.0.0",
        displayName: "GitHub Dark Default",
        engines: { vscode: "*" },
        categories: ["Themes"],
        contributes: {
          themes: [{ label: "GitHub Dark Default", uiTheme: "vs-dark", path: "./themes/dark-default.json" }],
        },
      };
      return `
import { registerExtension } from "@codingame/monaco-vscode-api/extensions";
const { registerFileUrl } = registerExtension(${JSON.stringify(manifest)}, undefined, { system: true });
registerFileUrl("themes/dark-default.json", ${JSON.stringify(githubThemeUrl)}, { mimeType: "application/json", size: ${githubThemeJson.length} });
`;
    },
  };
}

function markdownStylePlugin(): Plugin {
  return {
    name: "issue-pilot-markdown-preview-style",
    resolveId(id) {
      return id === markdownStyleModule ? resolvedMarkdownStyleModule : undefined;
    },
    load(id) {
      if (id !== resolvedMarkdownStyleModule) return undefined;
      return `export const previewCss = ${JSON.stringify(markdownPreviewCss)};`;
    },
  };
}

function materialThemePlugin(): Plugin {
  return {
    name: "issue-pilot-material-theme",
    enforce: "pre",
    resolveId(id) {
      return id === materialThemeModule ? resolvedMaterialThemeModule : undefined;
    },
    load(id) {
      if (id !== resolvedMaterialThemeModule) return undefined;
      const manifest = {
        name: materialThemeManifest.name,
        publisher: materialThemeManifest.publisher,
        version: materialThemeManifest.version,
        displayName: materialThemeManifest.displayName,
        description: materialThemeManifest.description,
        engines: materialThemeManifest.engines,
        categories: ["Themes"],
        contributes: {
          iconThemes: [{ id: "material-icon-theme", label: "Material Icon Theme", path: "./dist/material-icons.json" }],
        },
      };
      const resources = [
        { extensionPath: "dist/material-icons.json", absolutePath: materialIconsPath, mimeType: "application/json" },
        ...materialIconPaths.map(({ extensionPath, absolutePath }) => ({ extensionPath, absolutePath, mimeType: "image/svg+xml" })),
      ];
      const registrations = resources.map(({ extensionPath, absolutePath, mimeType }) =>
        `registerFileUrl(${JSON.stringify(extensionPath)}, new URL(${JSON.stringify(absolutePath)}, import.meta.url).toString(), ${JSON.stringify({ mimeType, size: fs.statSync(absolutePath).size })});`
      ).join("\n");
      return `
import { registerExtension } from "@codingame/monaco-vscode-api/extensions";
const { registerFileUrl, whenReady } = registerExtension(${JSON.stringify(manifest)}, undefined, { system: true });
${registrations}
export { whenReady };
`;
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: "../../node_modules/.vite/issue-pilot-web",
  plugins: [
    githubThemePlugin(),
    markdownStylePlugin(),
    materialThemePlugin(),
    solidPlugin(),
  ],
  server: {
    host: issuePilotConfig.web.host,
    port: issuePilotConfig.web.port,
    watch: {
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 20 },
    },
    proxy: {
      "/api": { target: `http://127.0.0.1:${issuePilotConfig.http.port}`, ws: true },
    },
  },
  test: { setupFiles: ["./src/test-setup.ts"] },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: path.join(import.meta.dirname, "index.html"),
        vscode: path.join(import.meta.dirname, "vscode.html"),
      },
    },
  },
});
