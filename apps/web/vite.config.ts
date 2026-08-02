import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
  plugins: [solidPlugin()],
  server: {
    host: "0.0.0.0",
    port: 4173,
    proxy: { "/api": { target: "http://127.0.0.1:3000", ws: true } },
  },
  build: { target: "es2022" },
});
