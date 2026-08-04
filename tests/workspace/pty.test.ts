import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PtySessions } from "../../src/workspace/pty.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition_not_met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("shares one runner-owned interactive PTY with the browser and waits for settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-pty-"));
  const executable = join(root, "fake-pi.mjs");
  const sessionFile = join(root, "session.jsonl");
  await writeFile(executable, [
    "#!/usr/bin/env node",
    "import { appendFile } from 'node:fs/promises';",
    "const prompt = process.argv.at(-1);",
    "process.stdout.write('\\u001b[2J\\u001b[HPI:' + prompt);",
    "setTimeout(() => appendFile(process.env.ISSUE_PILOT_SETTLED_SIGNAL_FILE, 'settled\\n'), 50);",
    "process.stdin.on('data', (data) => process.stdout.write('INPUT:' + data));",
    "setInterval(() => {}, 1000);",
  ].join("\n"), { mode: 0o700 });
  await chmod(executable, 0o700);
  await writeFile(sessionFile, "", "utf8");

  const sessions = new PtySessions(executable, null, process.env, join(root, "signals"), 100);
  const output: string[] = [];
  try {
    const run = sessions.execute({ issueId: "issue-id", issueKey: "ISSUE-20260804-001", sessionFile, workspacePath: root }, {
      prompt: "handle this issue",
      provider: "test",
      model: "test-model",
      thinking: "medium",
    });
    await waitFor(() => sessions.has("issue-id"));
    const attachment = sessions.attach({ issueId: "issue-id", issueKey: "ISSUE-20260804-001", sessionFile, workspacePath: root }, {
      output: (data) => output.push(data),
      exit: () => undefined,
    }, 100, 30);
    await run;
    await waitFor(() => output.join("").includes("PI:handle this issue"));
    assert.match(output.join(""), /^\u001b\[2J\u001b\[HPI:handle this issue/);
    assert.equal(sessions.has("issue-id"), true);
    attachment.input("hello\r");
    await waitFor(() => output.join("").includes("INPUT:hello"));
    attachment.detach();
  } finally {
    sessions.close();
    await rm(root, { recursive: true, force: true });
  }
});
