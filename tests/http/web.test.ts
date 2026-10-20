import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildApi } from "../../src/http/api.ts";

const projectTools = { async start() {}, async close() {} };

test("serves the production Web and keeps unlisted files private", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-web-"));
  const webRoot = path.join(root, "web");
  const stateRoot = path.join(root, "state");
  try {
    await Promise.all([mkdir(path.join(webRoot, "assets"), { recursive: true }), mkdir(stateRoot)]);
    await Promise.all([
      writeFile(path.join(webRoot, "index.html"), "<!doctype html><title>Issue Pilot</title>"),
      writeFile(path.join(webRoot, "unlisted.html"), "<!doctype html><title>Unlisted</title>"),
      writeFile(path.join(webRoot, "assets", "app-123.js"), "globalThis.issuePilot = true;"),
      writeFile(path.join(webRoot, "private.txt"), "not public"),
    ]);
    const app = await buildApi({ stateRoot, databaseFile: path.join(stateRoot, "issues.db"), logger: false, projectTools, webRoot });
    try {
      const index = await app.inject({ method: "GET", url: "/" });
      assert.equal(index.statusCode, 200);
      assert.match(index.headers["content-type"] ?? "", /^text\/html/);
      assert.equal(index.headers["cache-control"], "private, no-cache, no-store, must-revalidate");
      assert.equal(index.headers["x-content-type-options"], "nosniff");

      const removedPage = await app.inject({ method: "GET", url: "/unlisted.html?issue=ISSUE-20260815-001", headers: { accept: "text/html" } });
      assert.equal(removedPage.statusCode, 404);

      const asset = await app.inject({ method: "GET", url: "/assets/app-123.js" });
      assert.equal(asset.statusCode, 200);
      assert.match(asset.headers["cache-control"] ?? "", /immutable/);
      assert.equal(asset.headers["x-content-type-options"], "nosniff");

      const spa = await app.inject({ method: "GET", url: "/issues/ISSUE-20260815-001", headers: { accept: "text/html" } });
      assert.equal(spa.statusCode, 200);
      assert.match(spa.body, /Issue Pilot/);

      const hidden = await app.inject({ method: "GET", url: "/private.txt" });
      assert.equal(hidden.statusCode, 404);
      assert.deepEqual(JSON.parse(hidden.body), { error: "not_found" });
      const missingApi = await app.inject({ method: "GET", url: "/api/missing", headers: { accept: "text/html" } });
      assert.equal(missingApi.statusCode, 404);
      assert.deepEqual(JSON.parse(missingApi.body), { error: "not_found" });
    } finally {
      await app.close();
    }
  } finally {
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
    await assert.rejects(buildApi({ stateRoot, databaseFile: path.join(stateRoot, "issues.db"), logger: false, projectTools, webRoot }), /web_build_file_missing:index\.html/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
