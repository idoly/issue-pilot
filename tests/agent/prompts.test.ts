import assert from "node:assert/strict";
import { test } from "node:test";

import { agentSystemPrompt, continuationPrompt, initialPrompt, promptWithRuntimeTime, runtimeTimeContext } from "../../src/agent/prompts.ts";

const now = new Date("2026-08-06T01:52:43.000Z");

test("gates code modification, development review and native query guidance on the Agent context", () => {
  for (const mode of ["investigation", "development", "data"] as const) {
    const development = mode === "development";
    const prompt = agentSystemPrompt({
      issueKey: "ISSUE-20261016-001",
      serviceKey: "service",
      environmentKey: development ? "dev" : "prod",
      model: { provider: "test", modelId: "test", thinkingLevel: "medium" },
      codemode: "off",
      capabilities: [],
      canModifyCode: development,
    });
    assert.equal(prompt.match(/# Karpathy Guidelines/g)?.length, 1);
    assert.match(prompt, /tool availability and tool validation as hard authorization boundaries/);
    // Native query guidance appears only when a capability is actually available.
    assert.doesNotMatch(prompt, /service_query/);
    assert.equal(prompt.includes("Development change review:"), development);
    assert.equal(prompt.includes("All repository workspaces are read-only"), !development);
    assert.equal(prompt.includes("Repository workspaces may be edited"), development);
  }
  const withCapabilities = agentSystemPrompt({
    issueKey: "ISSUE-20261016-001",
    serviceKey: "service",
    environmentKey: "prod",
    model: { provider: "test", modelId: "test", thinkingLevel: "medium" },
    codemode: "off",
    capabilities: ["dms"],
    canModifyCode: false,
  });
  assert.match(withCapabilities, /service_query/);
});

test("injects the runtime time and gates repository and related-Issue workspace guidance", () => {
  const expected = new RegExp("2026-08-06T09:52:43\\+08:00");
  assert.match(runtimeTimeContext(now), expected);
  assert.match(promptWithRuntimeTime("sls latest record", now), /sls latest record/);
  assert.match(promptWithRuntimeTime("sls latest record", now), expected);

  const readOnlyRepositories = [{ url: "git@example/repo.git", branch: "main", baseBranch: "main", baseCommit: "1234567890abcdef1234567890abcdef12345678", path: "/workspace/repo", readOnly: true }];
  const continuation = continuationPrompt("ISSUE-20260810-001", readOnlyRepositories, "/issues/issue-20260810-001/attachments", undefined, now);
  assert.match(continuation, expected);
  assert.match(continuation, /read-only snapshots/);
  assert.doesNotMatch(continuation, /workspace stage|commit or push/);
  const initial = initialPrompt(
    {
      issueKey: "ISSUE-20260810-001",
      title: "Latest log",
      description: "Read the latest SLS record",
      issueType: "smart_analysis",
      repositories: readOnlyRepositories,
      service: { key: "service", name: "Service" },
      attachmentPath: "/issues/issue-20260810-001/attachments",
    },
    now,
  );
  assert.match(initial, expected);
  assert.doesNotMatch(initial, /local changes/);
  assert.ok(initial.includes(`recorded baseline: ${readOnlyRepositories[0]!.baseCommit}`));
  assert.ok(initial.includes(`from ${readOnlyRepositories[0]!.baseBranch}`));

  const related = continuationPrompt("ISSUE-20260810-003", readOnlyRepositories, "/issues/issue-20260810-003/attachments", undefined, now, ["ISSUE-20260809-099"]);
  assert.match(related, /\.related-issue-20260809-099\.json/);
  assert.match(related, /read-only evidence/);
  assert.doesNotMatch(continuation, /related-issue/);

  const writable = continuationPrompt(
    "ISSUE-20260810-002",
    [{ ...readOnlyRepositories[0]!, branch: "issue-hotfix", baseBranch: "prod", readOnly: false }],
    "/issues/issue-20260810-002/attachments",
    undefined,
    now,
  );
  assert.match(writable, /issue-hotfix, writable, recorded baseline: .* from prod/);
  assert.doesNotMatch(writable, /read-only snapshots/);
  assert.match(writable, /unless the user explicitly asks you to commit or push them/);
  assert.match(writable, /workspace stage, unstage, commit or push/);
});
