import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { IssueStore } from "../src/store.ts";

const directories: string[] = [];

async function createStore(): Promise<IssueStore> {
  const directory = await mkdtemp(join(tmpdir(), "issue-agent-"));
  directories.push(directory);
  return new IssueStore(join(directory, "issues.json"), { now: () => new Date("2026-08-03T02:00:00.000Z"), timeZone: "UTC" });
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("creates normalized issues and persists audit history", async () => {
  const store = await createStore();
  const issue = await store.create({
    title: "  Login fails  ",
    labels: ["Auth", " auth ", "Frontend"],
    reporter: "alice",
  });

  assert.equal(issue.id, "ISSUE-20260803-001");
  assert.equal(issue.title, "Login fails");
  assert.deepEqual(issue.labels, ["auth", "frontend"]);
  assert.equal(issue.history[0]?.action, "created");
  assert.deepEqual((await store.get(issue.id))?.labels, ["auth", "frontend"]);
});

test("serializes concurrent writers without losing issues", async () => {
  const store = await createStore();
  const created = await Promise.all(
    Array.from({ length: 20 }, (_, index) => store.create({ title: `Issue ${index}` })),
  );

  assert.equal(new Set(created.map((issue) => issue.id)).size, 20);
  assert.equal((await store.metrics()).total, 20);
});

test("searches comments and sorts by priority", async () => {
  const store = await createStore();
  const low = await store.create({ title: "Slow report", priority: "p3" });
  const high = await store.create({ title: "Gateway unavailable", priority: "p0" });
  await store.addComment(low.id, "Observed timeout in billing", "bob");
  await store.addComment(high.id, "Billing gateway is down", "bob");

  const matches = await store.search({ query: "billing" });
  assert.deepEqual(matches.map((issue) => issue.id), [high.id, low.id]);
});

test("updates lifecycle fields and enforces optimistic concurrency", async () => {
  const store = await createStore();
  const issue = await store.create({ title: "Investigate queue" });
  const updated = await store.update(issue.id, {
    status: "resolved",
    assignee: "carol",
    expectedUpdatedAt: issue.updatedAt,
  });

  assert.equal(updated.status, "resolved");
  assert.equal(updated.assignee, "carol");
  assert.ok(updated.resolvedAt);
  assert.equal(updated.history.at(-1)?.action, "updated");

  await assert.rejects(
    store.update(issue.id, { priority: "p1", expectedUpdatedAt: issue.updatedAt }),
    /changed since/,
  );
});

test("aggregates cycle time, assignees, projects, and issue types", async () => {
  const store = await createStore();
  const first = await store.create({
    title: "API defect",
    type: "incident",
    assignee: "alice",
    repositories: [{ url: "git@example.com:team/api.git", baseBranch: "main" }],
  });
  await store.update(first.id, { status: "resolved" });
  await store.create({
    title: "UI request",
    type: "request",
    assignee: "bob",
    repositories: [{ url: "git@example.com:team/web.git", baseBranch: "main" }],
  });

  const statistics = await store.metrics();
  assert.equal(statistics.total, 2);
  assert.equal(statistics.completed, 1);
  assert.equal(statistics.byType.incident, 1);
  assert.equal(statistics.byType.request, 1);
  assert.equal(statistics.byAssignee.alice, 1);
  assert.equal(statistics.byProject["git@example.com:team/api.git"], 1);
  assert.ok(statistics.cycleTimeHours.average !== null);

  const personal = await store.metrics({ assignee: "alice" });
  assert.equal(personal.total, 1);
  assert.equal(personal.completed, 1);
});

test("reports corrupt data instead of silently replacing it", async () => {
  const store = await createStore();
  await writeFile(store.filePath, "not-json", "utf8");
  await assert.rejects(store.search(), /invalid JSON/);
  assert.equal(await readFile(store.filePath, "utf8"), "not-json");
});
