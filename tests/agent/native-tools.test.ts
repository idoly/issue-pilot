import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertIssueHardlinks, issueBashOperations, issueEditTool, issueNativeTools, issueWriteTool } from "../../src/agent/native-tools.ts";
import { shellQuote } from "../../src/agent/issue-sandbox.ts";
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-write-boundary-")), own = path.join(root, "own"), other = path.join(root, "other");
  await mkdir(own); await mkdir(other); await writeFile(path.join(other, "evidence.txt"), "untouched");
  return { root, own, other, async close() { await rm(root, { recursive: true, force: true }); } };
}
const invoke = (tool: ReturnType<typeof issueWriteTool> | ReturnType<typeof issueEditTool>, input: unknown) => tool.execute("guard", input as never, undefined, undefined, {} as never);
test("native write and edit can change this Issue's files but reject absolute, parent and symlink escapes", async () => {
  const f = await fixture();
  try {
    const write = issueWriteTool(f.own), edit = issueEditTool(f.own);
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
  } finally { await f.close(); }
});
test("Bash, Python and Node cannot modify or delete another Issue through real paths or symlinks", async () => {
  const f = await fixture();
  try {
    await symlink(f.other, path.join(f.own, "linked"));
    const operations = issueBashOperations(f.own), output: Buffer[] = [];
    const run = (command: string) => operations.exec(command, f.own, { onData: data => { output.push(data); } });
    assert.equal((await run("printf own > allowed.txt")).exitCode, 0);
    assert.notEqual((await run(`printf forbidden > ${shellQuote(path.join(f.other, "evidence.txt"))}`)).exitCode, 0);
    assert.notEqual((await run("rm linked/evidence.txt")).exitCode, 0);
    assert.notEqual((await run(`${shellQuote(process.execPath)} -e ${shellQuote("require('node:fs').writeFileSync('../other/evidence.txt','forbidden')")}`)).exitCode, 0);
    assert.notEqual((await run(`python3 -c ${shellQuote("from pathlib import Path; Path('../other/evidence.txt').unlink()")}`)).exitCode, 0);
    assert.notEqual((await run(`ln ${shellQuote(path.join(f.other, "evidence.txt"))} external-hardlink`)).exitCode, 0);
    assert.equal(await readFile(path.join(f.other, "evidence.txt"), "utf8"), "untouched");
    assert.equal(await readFile(path.join(f.own, "allowed.txt"), "utf8"), "own");
  } finally { await f.close(); }
});
test("cancelling a command drains its process tree before the next operation", async () => {
  const f = await fixture();
  try {
    const bash = issueNativeTools({ writeRoot: f.own }).find(tool => tool.name === "bash")!, controller = new AbortController(), reason = new Error("cancelled");
    const code = "process.stdout.write('ready\\n');setTimeout(()=>require('node:fs').writeFileSync('late.txt','old'),300);setInterval(()=>{},1000)";
    const operation = bash.execute("cancel", { command: `${shellQuote(process.execPath)} -e ${shellQuote(code)}` }, controller.signal, result => {
      if (result.content.some((item: { type: string; text?: string }) => item.type === "text" && item.text?.includes("ready"))) controller.abort(reason);
    }, {} as never);
    await assert.rejects(operation, error => error === reason);
    await invoke(issueWriteTool(f.own), { path: "late.txt", content: "new" });
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(await readFile(path.join(f.own, "late.txt"), "utf8"), "new");
  } finally { await f.close(); }
});
test("pre-existing hardlinks outside the Issue are detected before a session starts", async () => {
  const f = await fixture();
  try {
    await link(path.join(f.other, "evidence.txt"), path.join(f.own, "shared.txt"));
    await assert.rejects(assertIssueHardlinks(f.own), /issue_external_hardlink_requires_inspection/);
    await rm(path.join(f.own, "shared.txt")); await assertIssueHardlinks(f.own);
  } finally { await f.close(); }
});
