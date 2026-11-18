import assert from "node:assert/strict";
import { test } from "node:test";

import { agentSystemPrompt, continuationPrompt, initialPrompt, promptWithRuntimeTime, runtimeTimeContext } from "../../src/agent/prompts.ts";

const now = new Date("2026-08-06T01:52:43.000Z");

const baseContext = {
  issueKey: "ISSUE-20261016-001",
  serviceKey: "service",
  environmentKey: "prod",
  model: { provider: "test", modelId: "test", thinkingLevel: "medium" as const },
  codemode: "off" as const,
  capabilities: [] as Array<"dms" | "sls">,
  canModifyCode: false,
};

test("gates code modification, development review and coding guidelines on the environment kind", () => {
  for (const environmentKind of ["prod", "test", "dev"] as const) {
    const development = environmentKind === "dev";
    // canModifyCode can be false in dev (for example before any repository is included); tools still follow the environment kind.
    const prompt = agentSystemPrompt({ ...baseContext, environmentKey: environmentKind }, { environmentKind, mcpTools: false });
    assert.equal(prompt.match(/# Karpathy Guidelines/g)?.length ?? 0, development ? 1 : 0);
    assert.equal(prompt.includes("The project verification policy above takes precedence"), development);
    assert.match(prompt, /tool availability and tool validation as hard authorization boundaries/);
    assert.match(prompt, /Reply to users in Simplified Chinese unless the user asks for another language/);
    // Native query and MCP guidance appear only when those tools are actually available.
    assert.doesNotMatch(prompt, /service_query|mcp__/);
    assert.equal(prompt.includes("Development change review:"), development);
    assert.equal(prompt.includes("shared read-only snapshots of recorded baselines"), !development);
    assert.equal(prompt.includes("writable worktrees on its own branches and may be edited"), development);
    assert.equal(prompt.includes("explicitly select the source environment for every query"), development);
    assert.equal(prompt.includes("Query and describe services only in the Issue's environment."), !development);
    assert.equal(prompt.match(/Do not run dependency installation or a full build as a routine step/g)?.length, 1);
  }
  const withTools = agentSystemPrompt({ ...baseContext, capabilities: ["dms"] }, { environmentKind: "prod", mcpTools: true });
  assert.match(withTools, /service_query/);
  assert.match(withTools, /MCP servers configured for this Issue's entry and included services expose separate mcp__ tools/);
  assert.doesNotMatch(withTools, /global MCP|every Issue environment/);
  // DMS pacing and backoff belong to the service_query tool guidelines, not the system prompt.
  assert.match(withTools, /resume from verified checkpoints/);
  assert.doesNotMatch(withTools, /serially with spacing|quota/);
});

test("injects the runtime time and gates repository and related-Issue workspace guidance", () => {
  const expected = new RegExp("2026-08-06T09:52:43\\+08:00");
  assert.match(runtimeTimeContext(now), expected);
  assert.match(promptWithRuntimeTime("sls latest record", now), /sls latest record/);
  assert.match(promptWithRuntimeTime("sls latest record", now), expected);

  const readOnlyRepositories = [{ url: "git@example/repo.git", branch: "main", baseBranch: "main", baseCommit: "1234567890abcdef1234567890abcdef12345678", path: "/workspace/repo", readOnly: true }];
  const continuation = continuationPrompt("ISSUE-20260810-001", readOnlyRepositories, "/issues/issue-20260810-001/attachments", undefined, now);
  assert.match(continuation, expected);
  assert.match(continuation, /\(main, read-only, recorded baseline/);
  assert.doesNotMatch(continuation, /Project checks|full npm or Maven builds/);
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
  assert.doesNotMatch(writable, /read-only/);
  assert.doesNotMatch(writable, /Project checks|full npm or Maven builds/);
  assert.match(writable, /unless the user explicitly asks you to commit or push them/);
  assert.match(writable, /workspace stage, unstage, commit or push/);
});

test("selects the work-mode playbook and states the verification ladder", () => {
  const prompt = (workMode: "production_analysis" | "test_analysis" | "development_fix" | "development_feature" | undefined, environmentKind: "prod" | "test" | "dev" = workMode?.startsWith("development") ? "dev" : "prod") =>
    agentSystemPrompt({ ...baseContext, environmentKey: environmentKind }, { environmentKind, mcpTools: false, workMode });

  const analysis = prompt("production_analysis");
  assert.match(analysis, /Problem-solving method:/);
  assert.match(analysis, /Trace a causal chain from that entry point to the symptom/);
  assert.match(analysis, /Investigation method:/);
  assert.match(analysis, /This Issue is read-only for code and data/);
  assert.doesNotMatch(analysis, /Change impact checklist|Defect fix method|Feature development method/);
  assert.equal(prompt("test_analysis").includes("Investigation method:"), true);

  const fix = prompt("development_fix");
  assert.match(fix, /Defect fix method:/);
  assert.match(fix, /Change impact checklist/);
  assert.match(fix, /The root cause must explain every observed symptom/);
  assert.doesNotMatch(fix, /Investigation method:|Feature development method/);

  const feature = prompt("development_feature");
  assert.match(feature, /Feature development method:/);
  assert.match(feature, /behavior contract before coding/);
  assert.match(feature, /Change impact checklist/);
  assert.doesNotMatch(feature, /Defect fix method/);

  // A stored environment/type pair without a work mode stays read-only and says so.
  const unmapped = prompt(undefined, "dev");
  assert.match(unmapped, /read-only outside the explicitly available tools/);
  assert.match(unmapped, /Problem-solving method:/);

  for (const value of [analysis, fix, feature]) {
    assert.match(value, /Verification policy:/);
    assert.match(value, /node --check/);
    assert.match(value, /python3 -m py_compile/);
    assert.match(value, /mvn -o compile/);
    assert.match(value, /Report exactly which checks you ran/);
  }
});
