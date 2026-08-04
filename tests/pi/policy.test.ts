import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertToolGranted,
  authorizeWorkspacePath,
  createIssuePolicy,
  loadIssuePolicy,
} from "../../src/pi/policy.ts";

test("enforces issue tool, repository-root, read-only, and symlink boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-policy-"));
  const workspace = join(root, "workspaces", "issue-20260804-002");
  const repository = join(workspace, "repository");
  const module = join(repository, "modules", "orders");
  const dependencyRepository = join(workspace, "dependency");
  const dependencyModule = join(dependencyRepository, "modules", "shared");
  const outside = join(root, "outside.txt");
  const capabilityFile = join(root, "capabilities", "issue-20260804-002.json");
  try {
    await Promise.all([mkdir(module, { recursive: true }), mkdir(dependencyModule, { recursive: true }), mkdir(join(root, "capabilities"), { recursive: true })]);
    await Promise.all([
      writeFile(join(repository, "README.md"), "repository", "utf8"),
      writeFile(join(module, "index.ts"), "export {};", "utf8"),
      writeFile(join(dependencyModule, "index.ts"), "export {};", "utf8"),
      writeFile(outside, "outside", "utf8"),
      symlink(outside, join(module, "escaped.txt")),
    ]);
    const policy = createIssuePolicy({
      issueKey: "ISSUE-20260804-002",
      issueType: "incident",
      workspaceRoot: workspace,
      service: {
        serviceKey: "orders",
        environmentKey: "test",
        environmentKind: "test",
        capabilities: ["configuration_read"],
        repositories: [
          { codeAccess: "write", repositoryPath: repository, baseCommit: "a".repeat(40) },
          { codeAccess: "read", repositoryPath: dependencyRepository, baseCommit: "b".repeat(40) },
        ],
      },
    });
    await writeFile(capabilityFile, JSON.stringify(policy), { mode: 0o600 });
    await chmod(capabilityFile, 0o600);

    const loaded = await loadIssuePolicy(workspace, root);
    assert.deepEqual(loaded.tools, ["read", "grep", "find", "ls", "edit", "write", "configuration_read", "node_project_command", "maven_project_command", "repository_status"]);
    assert.equal(await authorizeWorkspacePath(loaded, workspace, join(repository, "README.md"), "read"), join(repository, "README.md"));
    assert.equal(await authorizeWorkspacePath(loaded, workspace, join(module, "new.ts"), "write"), join(module, "new.ts"));
    assert.equal(await authorizeWorkspacePath(loaded, workspace, join(dependencyModule, "index.ts"), "read"), join(dependencyModule, "index.ts"));
    await assert.rejects(authorizeWorkspacePath(loaded, workspace, join(dependencyModule, "index.ts"), "write"), /workspace_path_not_granted/);
    assert.equal(await authorizeWorkspacePath(loaded, workspace, join(repository, "outside-module.ts"), "write"), join(repository, "outside-module.ts"));
    await assert.rejects(authorizeWorkspacePath(loaded, workspace, join(module, "escaped.txt"), "read"), /workspace_symlink_escape_not_granted/);
    await assert.rejects(authorizeWorkspacePath(loaded, workspace, outside, "read"), /workspace_path_not_granted/);
    assert.throws(() => assertToolGranted(loaded, "bash"), /tool_not_granted_for_issue/);
    await writeFile(capabilityFile, JSON.stringify({ ...policy, tools: [...policy.tools, "database_read"] }), { mode: 0o600 });
    await assert.rejects(loadIssuePolicy(workspace, root), /issue_policy_tool_set_mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses read-only code tools for non-mutating issue types", () => {
  const policy = createIssuePolicy({
    issueKey: "ISSUE-20260804-003",
    issueType: "question",
    workspaceRoot: "/tmp/issue-policy-question",
    service: {
      serviceKey: "orders",
      environmentKey: "test",
      environmentKind: "test",
      capabilities: [],
      repositories: [{ codeAccess: "read", repositoryPath: "/tmp/issue-policy-question/repository", baseCommit: "a".repeat(40) }],
    },
  });
  assert.equal(policy.tools.includes("read"), true);
  assert.equal(policy.tools.includes("write"), false);
  assert.equal(policy.tools.includes("edit"), false);
  assert.equal(policy.tools.includes("database_read"), false);
});
