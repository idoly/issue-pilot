import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readAttachment } from "../../src/pi/attachment.ts";
import {
  assertSlsGranted,
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
  const attachmentDirectory = join(root, "attachments", "issue-20260804-002");
  const attachmentPath = join(attachmentDirectory, "fixture-note.txt");
  const attachmentContent = "bounded attachment text";
  const capabilityFile = join(root, "capabilities", "issue-20260804-002.json");
  try {
    await Promise.all([mkdir(module, { recursive: true }), mkdir(dependencyModule, { recursive: true }), mkdir(join(root, "capabilities"), { recursive: true }), mkdir(attachmentDirectory, { recursive: true, mode: 0o700 })]);
    await Promise.all([
      writeFile(join(repository, "README.md"), "repository", "utf8"),
      writeFile(join(module, "index.ts"), "export {};", "utf8"),
      writeFile(join(dependencyModule, "index.ts"), "export {};", "utf8"),
      writeFile(outside, "outside", "utf8"),
      writeFile(attachmentPath, attachmentContent, { encoding: "utf8", mode: 0o600 }),
      symlink(outside, join(module, "escaped.txt")),
    ]);
    const policy = createIssuePolicy({
      issueKey: "ISSUE-20260804-002",
      issueType: "incident",
      workspaceRoot: workspace,
      attachments: [{ id: "attachment-1", fileName: "note.txt", mediaType: "text/plain", size: Buffer.byteLength(attachmentContent), sha256: createHash("sha256").update(attachmentContent).digest("hex"), attachmentPath }],
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
    assert.deepEqual(loaded.tools, ["repository_read", "repository_grep", "repository_find", "repository_list", "attachment_read", "repository_edit", "repository_write", "configuration_read", "node_project_command", "maven_project_command", "repository_status"]);
    const attachment = await readAttachment(loaded, "attachment-1");
    const attachmentContentResult = attachment.content[0];
    assert.match(attachmentContentResult?.type === "text" ? attachmentContentResult.text : "", /bounded attachment text/);
    await assert.rejects(readAttachment(loaded, "missing"), /attachment_not_granted_for_issue/);
    await writeFile(attachmentPath, "xounded attachment text", { encoding: "utf8", mode: 0o600 });
    await assert.rejects(readAttachment(loaded, "attachment-1"), /attachment_integrity_check_failed/);
    await writeFile(attachmentPath, attachmentContent, { encoding: "utf8", mode: 0o600 });
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

test("freezes SLS project and Logstore grants into the issue policy", () => {
  const policy = createIssuePolicy({
    issueKey: "ISSUE-20260804-004",
    issueType: "question",
    workspaceRoot: "/tmp/issue-policy-sls",
    service: {
      serviceKey: "orders",
      environmentKey: "test",
      environmentKind: "test",
      capabilities: ["sls_read"],
      sls: { project: "orders-test", logstores: ["application"] },
      repositories: [{ codeAccess: "read", repositoryPath: "/tmp/issue-policy-sls/repository", baseCommit: "a".repeat(40) }],
    },
  });
  assert.equal(policy.tools.includes("sls_read"), true);
  assert.doesNotThrow(() => assertSlsGranted(policy, "orders-test", "application"));
  assert.throws(() => assertSlsGranted(policy, "other-project", "application"), /sls_scope_not_granted_for_service/);
  const { sls: _sls, ...serviceWithoutSls } = policy.service;
  assert.throws(() => createIssuePolicy({ ...policy, service: serviceWithoutSls }), /invalid_sls_service_scope/);
});

test("freezes a credential-free browser origin into the issue policy", () => {
  const policy = createIssuePolicy({
    issueKey: "ISSUE-20260804-005",
    issueType: "incident",
    workspaceRoot: "/tmp/issue-policy-browser",
    service: {
      serviceKey: "orders",
      environmentKey: "development",
      environmentKind: "development",
      capabilities: ["browser_use"],
      browser: { deploymentId: "orders-development", baseUrl: "https://orders.example.test/admin/login" },
      repositories: [{ codeAccess: "write", repositoryPath: "/tmp/issue-policy-browser/repository", baseCommit: "a".repeat(40) }],
    },
  });
  assert.equal(policy.tools.includes("browser_use"), true);
  assert.deepEqual(policy.service.browser, { deploymentId: "orders-development", baseUrl: "https://orders.example.test/admin/login" });
  assert.doesNotMatch(JSON.stringify(policy), /password|username/);
  assert.throws(() => createIssuePolicy({ ...policy, service: { ...policy.service, browser: { deploymentId: "orders-development", baseUrl: "https://other.example.test/path?token=secret" } } }), /invalid_browser_service_scope/);
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
  assert.equal(policy.tools.includes("repository_read"), true);
  assert.equal(policy.tools.includes("repository_write"), false);
  assert.equal(policy.tools.includes("repository_edit"), false);
  assert.equal(policy.tools.includes("database_read"), false);
});
