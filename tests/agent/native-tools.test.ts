import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { assertIssueHardlinks, issueNativeTools } from "../../src/agent/native-tools.ts";
import { shellQuote } from "../../src/agent/issue-sandbox.ts";
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-write-boundary-")),
    own = path.join(root, "own"),
    other = path.join(root, "other");
  await mkdir(own);
  await mkdir(other);
  await writeFile(path.join(other, "evidence.txt"), "untouched");
  return {
    root,
    own,
    other,
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
const invoke = (tool: ReturnType<typeof issueNativeTools>[number], input: unknown) => tool.execute("guard", input as never, undefined, undefined, {} as never);
test("native tools reuse the host compile cache read-only and tolerate missing or disabled caches", async () => {
  const f = await fixture();
  const cache = path.join(f.other, "cache");
  const original = { NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE, NODE_DISABLE_COMPILE_CACHE: process.env.NODE_DISABLE_COMPILE_CACHE };
  try {
    const seedEnvironment: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: path.join(f.root, "agent"), NODE_COMPILE_CACHE: cache };
    delete seedEnvironment.NODE_DISABLE_COMPILE_CACHE;
    delete seedEnvironment.NODE_COMPILE_CACHE_READONLY;
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))})`], {
      env: seedEnvironment,
    });
    const fingerprint = async () => {
      const hash = createHash("sha256");
      for (const entry of (await readdir(cache, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
        hash.update(path.join(entry.parentPath, entry.name));
        hash.update(await readFile(path.join(entry.parentPath, entry.name)));
      }
      return hash.digest("hex");
    };
    const before = await fingerprint();
    process.env.NODE_COMPILE_CACHE = cache;
    delete process.env.NODE_DISABLE_COMPILE_CACHE;
    const tools = issueNativeTools({ writeRoot: f.own, readRoots: [cache] });
    const bash = tools.find((tool) => tool.name === "bash")!,
      read = tools.find((tool) => tool.name === "read")!;
    const run = async (code: string) => {
      const result = await invoke(bash, { command: `${shellQuote(process.execPath)} -e ${shellQuote(code)}` });
      return result.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n")
        .trimEnd();
    };
    const status = JSON.parse(await run("console.log(JSON.stringify({directory:require('node:module').getCompileCacheDir(),readOnly:process.env.NODE_COMPILE_CACHE_READONLY}))"));
    assert.ok(status.directory.startsWith(cache + path.sep));
    assert.equal(status.readOnly, "1");
    assert.equal(await run(`try { require('node:fs').writeFileSync(${JSON.stringify(path.join(cache, "untrusted"))}, 'poison'); } catch { console.log('blocked'); }`), "blocked");
    await writeFile(path.join(f.own, "note.txt"), "cached tool still reads");
    assert.match(JSON.stringify(await invoke(read, { path: "note.txt" })), /cached tool still reads/);
    assert.equal(await fingerprint(), before, "sandboxed tools must not change the service's compile cache");

    process.env.NODE_COMPILE_CACHE = path.join(cache, "missing");
    assert.match(JSON.stringify(await invoke(read, { path: "note.txt" })), /cached tool still reads/);
    await assert.rejects(readFile(path.join(cache, "missing")), { code: "ENOENT" });
    process.env.NODE_COMPILE_CACHE = cache;
    process.env.NODE_DISABLE_COMPILE_CACHE = "1";
    assert.equal(await run("console.log(String(require('node:module').getCompileCacheDir()))"), "undefined");
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await f.close();
  }
});
test("native write and edit can change this Issue's files but reject absolute, parent and symlink escapes", async () => {
  const f = await fixture();
  try {
    const tools = issueNativeTools({ writeRoot: f.own });
    const write = tools.find((tool) => tool.name === "write")!,
      edit = tools.find((tool) => tool.name === "edit")!;
    await invoke(write, { path: "note.txt", content: "before" });
    await invoke(edit, { path: "note.txt", edits: [{ oldText: "before", newText: "after" }] });
    assert.equal(await readFile(path.join(f.own, "note.txt"), "utf8"), "after");
    await writeFile(path.join(f.own, ".session-private.jsonl"), "private session");
    await assert.rejects(invoke(write, { path: ".session-private.jsonl", content: "forbidden" }), /managed_issue_file_private/);
    await invoke(write, { path: "src/.session-business.txt", content: "ordinary nested file" });
    assert.equal(await readFile(path.join(f.own, "src", ".session-business.txt"), "utf8"), "ordinary nested file");
    await symlink(f.other, path.join(f.own, "linked"));
    for (const selected of [path.join(f.other, "evidence.txt"), "../other/evidence.txt", "linked/evidence.txt"]) {
      await assert.rejects(invoke(write, { path: selected, content: "forbidden" }), /issue_write_outside_directory/);
      await assert.rejects(invoke(edit, { path: selected, edits: [{ oldText: "untouched", newText: "forbidden" }] }), /issue_write_outside_directory/);
    }
    assert.equal(await readFile(path.join(f.other, "evidence.txt"), "utf8"), "untouched");
  } finally {
    await f.close();
  }
});
test("Bash, Python and Node cannot modify or delete another Issue through real paths or symlinks", async () => {
  const f = await fixture();
  try {
    await symlink(f.other, path.join(f.own, "linked"));
    const bash = issueNativeTools({ writeRoot: f.own }).find((tool) => tool.name === "bash")!;
    assert.doesNotMatch(JSON.stringify(await invoke(bash, { command: "printf own > allowed.txt" })), /exited with code/);
    for (const command of [
      `printf forbidden > ${shellQuote(path.join(f.other, "evidence.txt"))}`,
      "rm linked/evidence.txt",
      `${shellQuote(process.execPath)} -e ${shellQuote("require('node:fs').writeFileSync('../other/evidence.txt','forbidden')")}`,
      `python3 -c ${shellQuote("from pathlib import Path; Path('../other/evidence.txt').unlink()")}`,
      `ln ${shellQuote(path.join(f.other, "evidence.txt"))} external-hardlink`,
    ])
      assert.match(JSON.stringify(await invoke(bash, { command })), /exited with code [1-9]/);
    assert.equal(await readFile(path.join(f.other, "evidence.txt"), "utf8"), "untouched");
    assert.equal(await readFile(path.join(f.own, "allowed.txt"), "utf8"), "own");
  } finally {
    await f.close();
  }
});
test("cancelling a command drains its process tree before the next operation", async () => {
  const f = await fixture();
  try {
    const bash = issueNativeTools({ writeRoot: f.own }).find((tool) => tool.name === "bash")!,
      controller = new AbortController(),
      reason = new Error("cancelled");
    const code = "process.stdout.write('ready\\n');setTimeout(()=>require('node:fs').writeFileSync('late.txt','old'),50);setInterval(()=>{},1000)";
    const operation = bash.execute(
      "cancel",
      { command: `${shellQuote(process.execPath)} -e ${shellQuote(code)}` },
      controller.signal,
      (result) => {
        if (result.content.some((item: { type: string; text?: string }) => item.type === "text" && item.text?.includes("ready"))) controller.abort(reason);
      },
      {} as never,
    );
    await assert.rejects(operation, (error) => error === reason);
    await invoke(issueNativeTools({ writeRoot: f.own }).find((tool) => tool.name === "write")!, { path: "late.txt", content: "new" });
    // A leaked child writes 50ms after start; poll with a generous margin and fail as soon as it appears.
    const late = path.join(f.own, "late.txt");
    const deadline = Date.now() + 2_000;
    let leaked = false;
    while (Date.now() < deadline) {
      if ((await readFile(late, "utf8")) !== "new") {
        leaked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(leaked, false, "cancelled command tree wrote after cancellation");
  } finally {
    await f.close();
  }
});
test("pre-existing hardlinks outside the Issue are detected before a session starts", async () => {
  const f = await fixture();
  try {
    await link(path.join(f.other, "evidence.txt"), path.join(f.own, "shared.txt"));
    await assert.rejects(assertIssueHardlinks(f.own), /issue_external_hardlink_requires_inspection/);
    await rm(path.join(f.own, "shared.txt"));
    await assertIssueHardlinks(f.own);
  } finally {
    await f.close();
  }
});
