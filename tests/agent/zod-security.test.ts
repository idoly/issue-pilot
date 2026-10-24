import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const project = fileURLToPath(new URL("../../", import.meta.url));
const probe = fileURLToPath(new URL("../helpers/zod-security-probe.mjs", import.meta.url));
const patchFiles = ["@earendil-works+pi-coding-agent+1.4.0.patch", "node-forge+1.4.0.patch", "zod+3.25.76.patch"];
const targets = ["zod", "@modelcontextprotocol/sdk", "@anthropic-ai/sandbox-runtime", "@earendil-works/pi-coding-agent", "node-forge"];

async function patchedPaths(): Promise<string[]> {
  const files = await Promise.all(patchFiles.map(name => readFile(path.join(project, "patches", name), "utf8")));
  return files.flatMap(contents => [...contents.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1]!));
}

async function hashes(root: string): Promise<string[]> {
  return Promise.all((await patchedPaths()).map(async file => createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")));
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-zod-security-"));
  const source = await realpath(path.join(project, "node_modules"));
  try {
    for (const name of targets) {
      const destination = path.join(root, "node_modules", name);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(source, name), destination, { recursive: true });
      assert.ok((await realpath(destination)).startsWith(root + path.sep), "patch targets must never link to the shared installation");
    }
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.name.startsWith("@")) {
        const destination = path.join(root, "node_modules", entry.name);
        await mkdir(destination, { recursive: true });
        for (const name of await readdir(path.join(source, entry.name))) {
          if (!targets.includes(`${entry.name}/${name}`)) await symlink(path.join(source, entry.name, name), path.join(destination, name));
        }
      } else if (!targets.includes(entry.name)) {
        await symlink(path.join(source, entry.name), path.join(root, "node_modules", entry.name));
      }
    }
    await mkdir(path.join(root, "scripts"));
    await mkdir(path.join(root, "patches"));
    await copyFile(path.join(project, "scripts/apply-pi-sdk-patch.mjs"), path.join(root, "scripts/apply-pi-sdk-patch.mjs"));
    for (const name of patchFiles) await copyFile(path.join(project, "patches", name), path.join(root, "patches", name));
    for (const file of await patchedPaths()) assert.ok((await realpath(path.join(root, file))).startsWith(root + path.sep), "every patched file must remain inside the isolated fixture");
    const patch = path.join(root, "patches/zod+3.25.76.patch");
    let installed = false;
    try { await exec("git", ["apply", "--reverse", "--check", patch], { cwd: root }); installed = true; }
    catch { await exec("git", ["apply", "--check", patch], { cwd: root }); }
    if (installed) await exec("git", ["apply", "--reverse", patch], { cwd: root });
    return { root, source };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

test("backports constrained-collection guards in isolation with MCP compatibility and repeatable installation", { timeout: 30_000 }, async () => {
  const original = await hashes(project);
  const { root } = await fixture();
  try {
    const before = await exec(process.execPath, ["--max-old-space-size=256", probe, root, "before"], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    const pristine = JSON.parse(before.stdout) as { results: Array<{ oversizedIssues: number }>; completionIssues: number };
    assert.equal(pristine.results.length, 6);
    assert.ok(pristine.results.every(result => result.oversizedIssues === 10_001));
    assert.equal(pristine.completionIssues, 10_001);
    const install = path.join(root, "scripts/apply-pi-sdk-patch.mjs");
    const first = await exec(process.execPath, [install], { cwd: root });
    assert.match(first.stdout, /Verified dependency patch: zod@3\.25\.76/);
    const after = await exec(process.execPath, ["--max-old-space-size=256", probe, root, "after"], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    const patched = JSON.parse(after.stdout) as { results: Array<{ oversizedIssues: number }>; completionIssues: number; protocolRoundTrip: boolean; sandboxPolicyCompatible: boolean };
    assert.ok(patched.results.every(result => result.oversizedIssues === 1));
    assert.equal(patched.completionIssues, 1);
    assert.equal(patched.protocolRoundTrip, true);
    assert.equal(patched.sandboxPolicyCompatible, true);
    const verified = await hashes(root);
    await exec(process.execPath, [install], { cwd: root });
    assert.deepEqual(await hashes(root), verified, "repeated installation must not modify already patched runtime files");
    assert.deepEqual(await hashes(project), original, "security probes must not mutate the live shared dependency installation");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses Zod version drift and patch-context drift rather than silently applying an incompatible backport", { timeout: 30_000 }, async () => {
  const original = await hashes(project);
  const { root } = await fixture();
  try {
    const install = path.join(root, "scripts/apply-pi-sdk-patch.mjs");
    const metadata = path.join(root, "node_modules/zod/package.json");
    const contents = await readFile(metadata, "utf8");
    await writeFile(metadata, JSON.stringify({ ...JSON.parse(contents), version: "3.25.77" }));
    await assert.rejects(exec(process.execPath, [install], { cwd: root }), /dependency_patch_version_mismatch:zod/);
    await writeFile(metadata, contents);
    await exec(process.execPath, [install], { cwd: root });
    const runtime = path.join(root, "node_modules/zod/v4/core/schemas.js");
    const modified = (await readFile(runtime, "utf8")).replace("maximum >= 0", "maximum > 0");
    await writeFile(runtime, modified);
    await assert.rejects(exec(process.execPath, [install], { cwd: root }), /dependency_patch_does_not_apply:zod/);
    assert.deepEqual(await hashes(project), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
