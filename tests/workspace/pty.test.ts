import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    "import { appendFile, readFile, readdir, unlink } from 'node:fs/promises';",
    "process.stdout.write('\\u001b[2J\\u001b[HPI_READY\\nARGS:' + JSON.stringify(process.argv.slice(2)));",
    "let draining = false;",
    "async function drain() {",
    "  if (draining) return; draining = true;",
    "  try { for (const name of (await readdir(process.env.ISSUE_PILOT_INTERNAL_MESSAGE_DIRECTORY)).filter(name => name.endsWith('.json')).sort()) {",
    "    const file = process.env.ISSUE_PILOT_INTERNAL_MESSAGE_DIRECTORY + '/' + name;",
    "    const message = JSON.parse(await readFile(file, 'utf8'));",
    "    await appendFile(process.argv[process.argv.indexOf('--session') + 1] + '.received', message.content + '\\n');",
    "    await unlink(file);",
    "    process.stdout.write('\\nHIDDEN_MESSAGE_RECEIVED');",
    "    await appendFile(process.env.ISSUE_PILOT_SETTLED_SIGNAL_FILE, 'settled\\n');",
    "  } } finally { draining = false; }",
    "}",
    "setInterval(() => void drain(), 10);",
    "process.stdin.on('data', (data) => process.stdout.write('INPUT:' + data));",
  ].join("\n"), { mode: 0o700 });
  await chmod(executable, 0o700);
  await writeFile(sessionFile, "", "utf8");

  const sessions = new PtySessions(executable, null, process.env, join(root, "signals"), 100);
  const output: string[] = [];
  const binding = { issueId: "issue-id", issueKey: "ISSUE-20260804-001", sessionFile, workspacePath: root, policyHash: "policy-v1", tools: ["repository_read", "repository_edit"] };
  const client = { output: (data: string) => output.push(data), exit: () => undefined };
  try {
    assert.throws(() => sessions.attach(binding, client, 100, 30), /pi_terminal_not_runner_owned/);
    const run = sessions.execute(binding, {
      prompt: "handle this issue",
      provider: "test",
      model: "test-model",
      thinking: "medium",
    });
    await waitFor(() => sessions.has("issue-id"));
    const attachment = sessions.attach(binding, client, 100, 30);
    await run;
    await waitFor(() => output.join("").includes("HIDDEN_MESSAGE_RECEIVED"));
    assert.match(output.join(""), /^\u001b\[2J\u001b\[HPI_READY/);
    assert.doesNotMatch(output.join(""), /handle this issue/);
    assert.equal(sessions.has("issue-id"), true);
    assert.match(output.join(""), /--no-approve/);
    assert.match(output.join(""), /--no-extensions/);
    assert.match(output.join(""), /--no-builtin-tools/);
    assert.match(output.join(""), /--tools","repository_read,repository_edit/);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const transcript = await sessions.readTranscript(sessionFile);
    assert.ok(transcript);
    assert.match(transcript.data, /^\u001b\[2J\u001b\[HPI_READY/);
    assert.doesNotMatch(transcript.data, /handle this issue/);
    assert.equal(transcript.columns, 100);
    assert.equal(transcript.rows, 30);
    assert.equal((await stat(`${sessionFile}.pty`)).mode & 0o777, 0o600);
    assert.equal((await stat(`${sessionFile}.pty.json`)).mode & 0o777, 0o600);
    const continued = sessions.execute(binding, { prompt: "private issue update", provider: "test", model: "test-model", thinking: "medium" });
    await continued;
    assert.equal(await readFile(`${sessionFile}.received`, "utf8"), "handle this issue\nprivate issue update\n");
    assert.doesNotMatch(output.join(""), /private issue update/);
    attachment.input("hello\r");
    await waitFor(() => output.join("").includes("INPUT:hello"));
    attachment.detach();
  } finally {
    await sessions.close();
    await rm(root, { recursive: true, force: true });
  }
});
