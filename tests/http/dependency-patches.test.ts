import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { assertRuntimeDependencyPatches, verifyDependencyPatches } from "../../src/http/dependency-patches.ts";

const patch = `diff --git a/node_modules/demo/index.js b/node_modules/demo/index.js
--- a/node_modules/demo/index.js
+++ b/node_modules/demo/index.js
@@ -1,2 +1,2 @@
 export const stable = true;
-export const patched = false;
+export const patched = true;
`;

test("startup refuses dependency files that do not contain the patch's added lines", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-patches-"));
  try {
    await mkdir(path.join(root, "patches"));
    await mkdir(path.join(root, "node_modules", "demo"), { recursive: true });
    await writeFile(path.join(root, "patches", "demo.patch"), patch);
    const target = path.join(root, "node_modules", "demo", "index.js");
    const url = pathToFileURL(root + path.sep);
    await writeFile(target, "export const stable = true;\nexport const patched = false;\n");
    await assert.rejects(verifyDependencyPatches(url, ["demo.patch"]), /^Error: dependency_patch_not_applied:node_modules\/demo\/index\.js/);
    await writeFile(target, "export const stable = true;\nexport const patched = true;\n");
    await verifyDependencyPatches(url, ["demo.patch"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the installed runtime dependencies carry their patches", async () => {
  await assertRuntimeDependencyPatches();
});
