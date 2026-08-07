import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { createPrivateSessionManager } from "../../src/agent/session.ts";

test("creates a private Pi session file before the first Agent prompt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-session-"));
  try {
    const workspace = path.join(root, "workspace");
    const sessionDirectory = path.join(root, "sessions");
    await mkdir(workspace);
    await mkdir(sessionDirectory, { mode: 0o700 });

    const manager = await createPrivateSessionManager(workspace, sessionDirectory);
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    assert.equal((await stat(sessionFile)).mode & 0o777, 0o600);

    const [header] = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(header.type, "session");
    assert.equal(header.id, manager.getSessionId());

    manager.appendCustomEntry("issue-pilot-user", { message: "hello" });
    const reopened = SessionManager.open(sessionFile, sessionDirectory, workspace);
    assert.deepEqual(reopened.getEntries().map((entry) => entry.type), ["custom"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
