import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PiPtySessionManager } from "../src/pi-pty-sessions.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for PTY output");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("keeps one pi PTY alive across detach and reattach", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pty-session-"));
  const launcher = join(root, "pi-test");
  await writeFile(launcher, "#!/bin/sh\nexec /bin/sh\n", "utf8");
  await chmod(launcher, 0o700);
  const manager = new PiPtySessionManager(launcher, null, { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color" }, 10_000);
  const binding = { issueId: "issue-id", issueKey: "ISSUE-0001", sessionFile: join(root, "session.jsonl"), workspacePath: root };
  let firstOutput = "";
  const first = manager.attach(binding, { output: (data) => { firstOutput += data; }, exit: () => {} }, 100, 30);
  assert.throws(() => manager.attach(binding, { output: () => {}, exit: () => {} }, 100, 30), /pi_terminal_already_open/);
  first.input("echo FIRST_PID:$$\n");
  await waitFor(() => /FIRST_PID:\d+/.test(firstOutput));
  const firstPid = /FIRST_PID:(\d+)/.exec(firstOutput)?.[1];
  first.detach();

  let secondOutput = "";
  const second = manager.attach(binding, { output: (data) => { secondOutput += data; }, exit: () => {} }, 120, 40);
  second.input("echo SECOND_PID:$$\n");
  await waitFor(() => /SECOND_PID:\d+/.test(secondOutput));
  assert.equal(/SECOND_PID:(\d+)/.exec(secondOutput)?.[1], firstPid);
  assert.equal(await manager.releaseDetached(binding.issueId), false);
  second.detach();
  assert.equal(await manager.releaseDetached(binding.issueId), true);
  manager.close();
  await rm(root, { recursive: true, force: true });
});
