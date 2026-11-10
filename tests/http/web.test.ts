import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

import { buildApi } from "../../src/http/api.ts";
import { modelCatalog } from "./fixture.ts";

const stateLease = { async start() {}, async close() {} };

test("serves the production Web and keeps unlisted files private", async (context) => {
  const listenerWarnings: Error[] = [];
  const onWarning = (warning: Error) => {
    if (warning.name === "MaxListenersExceededWarning") listenerWarnings.push(warning);
  };
  process.on("warning", onWarning);
  context.after(() => {
    process.off("warning", onWarning);
  });
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-web-"));
  const webRoot = path.join(root, "web");
  const stateRoot = path.join(root, "state");
  try {
    await Promise.all([mkdir(path.join(webRoot, "assets"), { recursive: true }), mkdir(stateRoot)]);
    await Promise.all([
      writeFile(path.join(webRoot, "index.html"), "<!doctype html><title>Issue Pilot</title>"),
      writeFile(path.join(webRoot, "unlisted.html"), "<!doctype html><title>Unlisted</title>"),
      writeFile(path.join(webRoot, "assets", "app-b1c2d3e4.js"), "globalThis.issuePilot = true;"),
      writeFile(path.join(webRoot, "assets", "app-icon.svg"), "<svg/>"),
      writeFile(path.join(webRoot, "private.txt"), "not public"),
    ]);
    const app = await buildApi({ stateRoot, databaseFile: path.join(stateRoot, "issues.db"), logger: false, modelCatalog, stateLease, webRoot });
    try {
      const index = await app.inject({ method: "GET", url: "/" });
      assert.equal(index.statusCode, 200);
      assert.match(index.headers["content-type"] ?? "", /^text\/html/);
      assert.equal(index.headers["cache-control"], "private, no-cache, no-store, must-revalidate");
      assert.equal(index.headers["x-content-type-options"], "nosniff");
      assert.match(String(index.headers["content-security-policy"]), /default-src 'self'/);
      assert.match(String(index.headers["content-security-policy"]), /frame-ancestors 'none'/);
      assert.equal(index.headers["x-frame-options"], "DENY");
      assert.equal(index.headers["referrer-policy"], "no-referrer");

      const removedPage = await app.inject({ method: "GET", url: "/unlisted.html?issue=ISSUE-20260815-001", headers: { accept: "text/html" } });
      assert.equal(removedPage.statusCode, 404);

      // Only content-hashed bundles may be cached immutably; public stable names must revalidate soon.
      const asset = await app.inject({ method: "GET", url: "/assets/app-b1c2d3e4.js" });
      assert.equal(asset.statusCode, 200);
      assert.match(asset.headers["cache-control"] ?? "", /immutable/);
      assert.equal(asset.headers["x-content-type-options"], "nosniff");
      const publicAsset = await app.inject({ method: "GET", url: "/assets/app-icon.svg" });
      assert.equal(publicAsset.statusCode, 200);
      assert.doesNotMatch(publicAsset.headers["cache-control"] ?? "", /immutable/);
      assert.match(publicAsset.headers["cache-control"] ?? "", /max-age=3600/);

      const spa = await app.inject({ method: "GET", url: "/issues/ISSUE-20260815-001", headers: { accept: "text/html" } });
      assert.equal(spa.statusCode, 200);
      assert.match(spa.body, /Issue Pilot/);

      const hidden = await app.inject({ method: "GET", url: "/private.txt" });
      assert.equal(hidden.statusCode, 404);
      assert.deepEqual(JSON.parse(hidden.body), { error: "not_found" });
      const missingApi = await app.inject({ method: "GET", url: "/api/missing", headers: { accept: "text/html" } });
      assert.equal(missingApi.statusCode, 404);
      assert.deepEqual(JSON.parse(missingApi.body), { error: "not_found" });

      // A compatible Web release stages new assets first, then atomically replaces the HTML entrypoint.
      await writeFile(path.join(webRoot, "assets", "app-e5f6a7b8.js"), "globalThis.issuePilot = 'updated';");
      await writeFile(path.join(webRoot, ".next-index.html"), '<!doctype html><script src="/assets/app-e5f6a7b8.js"></script>');
      await rename(path.join(webRoot, ".next-index.html"), path.join(webRoot, "index.html"));
      assert.match((await app.inject("/")).body, /app-e5f6a7b8/);
      assert.match((await app.inject("/assets/app-e5f6a7b8.js")).body, /updated/);
      assert.equal((await app.inject("/assets/app-b1c2d3e4.js")).body, asset.body);
    } finally {
      await app.close();
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(listenerWarnings, [], "HTML fallback must not repeatedly assimilate the Fastify reply thenable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Fastify static preserves precomputed routes, special filenames and dotfile exclusion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-static-glob-"));
  const app = Fastify();
  try {
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "space [1].js"), "synthetic asset");
    await writeFile(path.join(root, ".private"), "not public");
    await app.register(fastifyStatic, { root, wildcard: false, index: false });
    const asset = await app.inject({ method: "GET", url: "/assets/space%20%5B1%5D.js" });
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.body, "synthetic asset");
    assert.equal((await app.inject({ method: "GET", url: "/.private" })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/assets/missing.js" })).statusCode, 404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("fails startup when the configured Web build is incomplete", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-web-missing-"));
  const webRoot = path.join(root, "web");
  const stateRoot = path.join(root, "state");
  try {
    await Promise.all([mkdir(webRoot), mkdir(stateRoot)]);
    await writeFile(path.join(webRoot, "assets-only.js"), "void 0;");
    const databaseFile = path.join(stateRoot, "issues.db");
    await assert.rejects(buildApi({ stateRoot, databaseFile, logger: false, stateLease, webRoot }), /web_build_file_missing:index\.html/);
    await assert.rejects(stat(databaseFile), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
