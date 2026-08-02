import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { IssueSessionService } from "../src/session-service.ts";
import { IssueStore } from "../src/store.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("creates one persistent pi session per issue and resumes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-sessions-"));
  directories.push(root);
  const store = new IssueStore(join(root, "issues.json"));
  const firstIssue = await store.create({ title: "First", repositories: [{ url: "repo", baseBranch: "main" }] });
  const secondIssue = await store.create({ title: "Second", repositories: [{ url: "repo", baseBranch: "release" }] });
  const service = new IssueSessionService(store, root);

  const first = await service.openOrCreate(firstIssue.id, join(root, "workspaces", firstIssue.id));
  first.appendCustomEntry("test", { issueId: firstIssue.id });
  const second = await service.openOrCreate(secondIssue.id, join(root, "workspaces", secondIssue.id));
  const resumed = await service.openOrCreate(firstIssue.id, join(root, "ignored"));

  assert.notEqual(first.getSessionId(), second.getSessionId());
  assert.notEqual(first.getSessionFile(), second.getSessionFile());
  assert.equal(resumed.getSessionId(), first.getSessionId());
  assert.ok(resumed.getEntries().some((entry) => entry.type === "custom" && entry.customType === "test"));
  assert.equal((await store.get(firstIssue.id))?.agentSession?.sessionFile, first.getSessionFile());
});
