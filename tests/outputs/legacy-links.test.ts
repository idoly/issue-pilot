import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { legacyOutputLinks, legacyOutputLinksFile, listIssueOutputs, resolveIssueOutput } from "../../src/outputs/store.ts";
import { issueWorkDirectory } from "../../src/workspace/state.ts";

const key = "ISSUE-20261023-001";

test("listing legacy downloads reads and validates one mapping snapshot", async context => {
  const state = await mkdtemp(path.join(tmpdir(), "issue-pilot-legacy-list-"));
  const root = issueWorkDirectory(state, key);
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "current.txt"), "current");
    const files = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`old-${index}.txt`, "current.txt"]));
    const manifest = path.join(root, legacyOutputLinksFile);
    await writeFile(manifest, JSON.stringify({ version: 1, files }), { mode: 0o600 });
    const read = fs.readFile;
    let reads = 0;
    context.mock.method(fs, "readFile", (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === manifest) reads++;
      return read(...args);
    });
    syncBuiltinESMExports();
    const listed = await listIssueOutputs(state, key);
    assert.equal(listed.length, 40);
    assert.ok(listed.every(file => file.size === 7));
    assert.equal(reads, 1);
    context.mock.restoreAll(); syncBuiltinESMExports();
    await writeFile(path.join(root, "current.txt"), "updated");
    assert.equal(await readFile(await resolveIssueOutput(state, key, "old-0.txt"), "utf8"), "updated");
  } finally {
    context.mock.restoreAll(); syncBuiltinESMExports();
    await rm(state, { recursive: true, force: true });
  }
});

for (const data of [null, [], "invalid", { version: 1, files: [] }, { version: 1, files: { old: null } }]) test(`invalid legacy mapping is a classified storage error: ${JSON.stringify(data)}`, async () => {
  const state = await mkdtemp(path.join(tmpdir(), "issue-pilot-legacy-invalid-"));
  try {
    const root = issueWorkDirectory(state, key);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, legacyOutputLinksFile), JSON.stringify(data), { mode: 0o600 });
    await assert.rejects(legacyOutputLinks(state, key), { message: "invalid_legacy_output_links" });
  } finally { await rm(state, { recursive: true, force: true }); }
});
