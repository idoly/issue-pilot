import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { DingTalkNotifier, formatCompletionMessage } from "../src/dingtalk.ts";
import { IssueStore } from "../src/store.ts";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function completedIssue() {
  const directory = await mkdtemp(join(tmpdir(), "dingtalk-test-"));
  directories.push(directory);
  const store = new IssueStore(join(directory, "issues.json"));
  const issue = await store.create({ title: "Checkout failure" });
  await store.recordTestRun(issue.id, { scope: "backend", command: "mvn test", status: "passed", summary: "passed" });
  await store.recordTestRun(issue.id, { scope: "frontend", command: "npm test", status: "passed", summary: "passed" });
  return (await store.update(issue.id, { status: "resolved" }));
}

test("sends a redacted idempotent completion message through dws", async () => {
  const issue = await completedIssue();
  const directory = directories[0]!;
  const executable = join(directory, "dws");
  await writeFile(executable, "#!/usr/bin/env node\nconsole.log(JSON.stringify({ args: process.argv.slice(2) }));\n", "utf8");
  await chmod(executable, 0o755);

  const notifier = new DingTalkNotifier({ executable, group: "cid-test", issueBaseUrl: "https://issues.example.com" });
  const first = await notifier.notifyCompleted(issue);
  const second = await notifier.notifyCompleted(issue);
  const args = (first.output as { args: string[] }).args;

  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.ok(args.includes("chat"));
  assert.ok(args.includes("cid-test"));
  assert.ok(args.some((arg) => arg.includes(issue.id)));
  assert.match(formatCompletionMessage(issue, "https://issues.example.com"), /backend: passed/);
});
