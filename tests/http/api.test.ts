import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";

import { openDatabase } from "../../src/db/client.ts";
import { agentSessions, issues, issueWorkspaces } from "../../src/db/schema.ts";
import { buildApi } from "../../src/http/api.ts";

const runner = {
  enqueued: [] as string[],
  running: new Set<string>(),
  enqueue(issueId: string) { this.enqueued.push(issueId); },
  isRunning(issueId: string) { return this.running.has(issueId); },
  enqueueDirect() {},
  async steerDirect() { return false; },
  async abortDirect() { return false; },
  async invalidatePolicy() { return true; },
  async getScopeCandidates() { return []; },
  async getTerminalTranscript() { return null; },
};

async function json(response: { body: string }): Promise<Record<string, unknown>> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

test("configuration and issue API preserves relational integrity", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-api-"));
  runner.enqueued = [];
  runner.running.clear();
  const app = await buildApi({ databaseFile: join(root, "issues.db"), stateRoot: root, runner: runner as never, logger: false });
  let appClosed = false;
  try {
    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);

    const configurationResponse = await app.inject({ method: "GET", url: "/api/config" });
    assert.equal(configurationResponse.statusCode, 200);
    const configuredEnvironments = (await json(configurationResponse)).environments as Array<{ key: string; name: string }>;
    assert.deepEqual(configuredEnvironments.map((environment) => environment.key).sort(), ["production", "test"]);
    assert.equal((await app.inject({ method: "POST", url: "/api/environments", payload: { key: "staging", name: "Staging" } })).statusCode, 404);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/environments/test", payload: { name: "Changed" } })).statusCode, 404);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/environments/test" })).statusCode, 404);

    for (const service of [
      { key: "alpha", name: "Alpha", repositoryUrls: ["https://example.test/alpha.git", "https://example.test/alpha-shared.git"] },
      { key: "beta", name: "Beta", repositoryUrls: ["https://example.test/beta.git"] },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/services",
        payload: {
          key: service.key,
          name: service.name,
          description: `${service.name} service`,
          repositories: service.repositoryUrls.map((url, index) => ({ kind: index === 0 ? "frontend" : "backend", url })),
          deployments: [{ environmentKey: "test", baseBranch: "main", capabilities: [] }],
        },
      });
      assert.equal(response.statusCode, 201, response.body);
    }

    const modeled = await app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ id: string; key: string; repositories: Array<{ id: string; kind: string; url: string }> }> };
    const alphaModel = modeled.services.find((service) => service.key === "alpha")!;
    assert.equal("kind" in alphaModel, false);
    assert.deepEqual(alphaModel.repositories.map((repository) => repository.kind).sort(), ["backend", "frontend"]);
    assert.deepEqual(alphaModel.repositories.map((repository) => repository.url).sort(), ["https://example.test/alpha-shared.git", "https://example.test/alpha.git"]);

    const invalidOrder = await app.inject({ method: "PUT", url: "/api/services/order", payload: { serviceKeys: ["alpha"] } });
    assert.equal(invalidOrder.statusCode, 400);
    assert.equal((await json(invalidOrder)).error, "invalid_service_order");
    const reordered = await app.inject({ method: "PUT", url: "/api/services/order", payload: { serviceKeys: ["beta", "alpha"] } });
    assert.equal(reordered.statusCode, 200, reordered.body);
    const reorderedConfiguration = await app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string }> };
    assert.deepEqual(reorderedConfiguration.services.map((service) => service.key), ["beta", "alpha"]);

    const invalidSubject = await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Unknown assignee",
        description: "",
        priority: "p2",
        type: "question",
        environmentKey: "test",
        serviceKey: "alpha",
        assigneeSubject: "missing-user",
        ccSubjects: [],
      },
    });
    assert.equal(invalidSubject.statusCode, 400);
    assert.equal((await json(invalidSubject)).error, "invalid_subject");

    const invalidPriority = await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Invalid priority",
        description: "",
        priority: "urgent",
        type: "question",
        environmentKey: "test",
        serviceKey: "alpha",
        assigneeSubject: null,
        ccSubjects: [],
      },
    });
    assert.equal(invalidPriority.statusCode, 400);
    assert.equal((await json(invalidPriority)).error, "invalid_priority");
    assert.deepEqual(await app.inject({ method: "GET", url: "/api/issues" }).then((response) => JSON.parse(response.body)), []);

    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Valid issue",
        description: "Investigate alpha",
        priority: "p1",
        type: "question",
        environmentKey: "test",
        serviceKey: "alpha",
        assigneeSubject: "demo-owner",
        ccSubjects: [],
      },
    });
    assert.equal(createdResponse.statusCode, 201, createdResponse.body);
    const created = await json(createdResponse);
    assert.match(String(created.id), /^ISSUE-[0-9]{8}-001$/);
    assert.equal(runner.enqueued.length, 1);
    const createdInternalId = runner.enqueued[0]!;
    runner.running.add(createdInternalId);
    const runningRetry = await app.inject({ method: "POST", url: `/api/issues/${created.id}/retry` });
    assert.equal(runningRetry.statusCode, 409);
    assert.equal((await json(runningRetry)).error, "issue_already_running");
    runner.running.delete(createdInternalId);
    const retryResponse = await app.inject({ method: "POST", url: `/api/issues/${created.id}/retry` });
    assert.equal(retryResponse.statusCode, 202, retryResponse.body);
    assert.equal(runner.enqueued.filter((id) => id === createdInternalId).length, 2);
    const retried = await app.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((response) => JSON.parse(response.body)) as { status: string };
    assert.equal(retried.status, "in_progress");
    const prematureResolve = await app.inject({ method: "PATCH", url: `/api/issues/${created.id}/status`, payload: { status: "resolved" } });
    assert.equal(prematureResolve.statusCode, 409);
    const direct = openDatabase(join(root, "issues.db"));
    await direct.db.update(issues).set({ status: "pending" }).where(eq(issues.key, String(created.id)));
    await direct.close();
    const resolved = await app.inject({ method: "PATCH", url: `/api/issues/${created.id}/status`, payload: { status: "resolved" } });
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.equal((await json(resolved)).status, "resolved");
    const reopened = await app.inject({ method: "PATCH", url: `/api/issues/${created.id}/status`, payload: { status: "open" } });
    assert.equal(reopened.statusCode, 200, reopened.body);
    assert.equal((await json(reopened)).status, "open");
    const followUp = await app.inject({ method: "POST", url: `/api/issues/${created.id}/comments`, payload: { body: "Please verify the follow-up" } });
    assert.equal(followUp.statusCode, 201, followUp.body);
    const afterFollowUp = await app.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((response) => JSON.parse(response.body)) as { status: string };
    assert.equal(afterFollowUp.status, "in_progress");

    const concurrentPayload = (title: string) => ({
      title,
      description: "",
      priority: "p2",
      type: "question",
      environmentKey: "test",
      serviceKey: "alpha",
      assigneeSubject: null,
      ccSubjects: [],
    });
    const concurrent = await Promise.all([
      app.inject({ method: "POST", url: "/api/issues", payload: concurrentPayload("Concurrent A") }),
      app.inject({ method: "POST", url: "/api/issues", payload: concurrentPayload("Concurrent B") }),
    ]);
    assert.deepEqual(concurrent.map((response) => response.statusCode), [201, 201]);
    const concurrentKeys = await Promise.all(concurrent.map(async (response) => String((await json(response)).id)));
    assert.equal(new Set(concurrentKeys).size, 2);
    assert.deepEqual(concurrentKeys.sort(), [String(created.id).replace(/001$/, "002"), String(created.id).replace(/001$/, "003")]);

    const invalidIssuePath = await app.inject({ method: "GET", url: "/api/issues/not-an-issue" });
    assert.equal(invalidIssuePath.statusCode, 404);

    const detailResponse = await app.inject({ method: "GET", url: `/api/issues/${created.id}` });
    assert.equal(detailResponse.statusCode, 200, detailResponse.body);
    const detail = await json(detailResponse);
    assert.equal(detail.title, "Valid issue");
    assert.equal((detail.service as { key: string }).key, "alpha");
    assert.equal("affectedModules" in detail, false);
    assert.equal("scopeCandidates" in detail, false);

    const staleSessionFile = join(root, "historical-session.jsonl");
    await writeFile(staleSessionFile, "{}\n", "utf8");
    const staleSession = openDatabase(join(root, "issues.db"));
    await staleSession.db.transaction(async (transaction) => {
      await transaction.update(issueWorkspaces).set({ status: "ready" }).where(eq(issueWorkspaces.issueId, createdInternalId));
      await transaction.insert(agentSessions).values({ issueId: createdInternalId, piSessionId: "historical-session", sessionFile: staleSessionFile, workspacePath: root });
    });
    await staleSession.close();
    const staleSessionDetail = await app.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((response) => JSON.parse(response.body)) as { agentSession: unknown; workspace: { retryable: boolean } };
    assert.equal(staleSessionDetail.agentSession, null);
    assert.equal(staleSessionDetail.workspace.retryable, true);
    const completedSession = openDatabase(join(root, "issues.db"));
    await completedSession.db.update(issues).set({ status: "pending" }).where(eq(issues.id, createdInternalId));
    await completedSession.close();
    const completedSessionDetail = await app.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((response) => JSON.parse(response.body)) as { workspace: { retryable: boolean } };
    assert.equal(completedSessionDetail.workspace.retryable, false);

    const retainedRepository = alphaModel.repositories.find((repository) => repository.url === "https://example.test/alpha.git")!;
    const repositoryUpdate = await app.inject({
      method: "PATCH",
      url: "/api/services/alpha",
      payload: {
        name: "Alpha renamed",
        description: "multiple repositories",
        repositories: [{ id: retainedRepository.id, kind: "frontend", url: retainedRepository.url }, { kind: "backend", url: "https://example.test/alpha-extra.git" }],
        deployments: [{ environmentKey: "test", baseBranch: "main", capabilities: ["configuration_read"] }],
      },
    });
    assert.equal(repositoryUpdate.statusCode, 200, repositoryUpdate.body);
    const afterRepositoryUpdate = await app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; name: string; deployments: Array<{ baseBranch: string; capabilities: string[] }>; repositories: Array<{ id: string; kind: string; url: string }> }> };
    const updatedAlpha = afterRepositoryUpdate.services.find((service) => service.key === "alpha")!;
    assert.equal(updatedAlpha.name, "Alpha renamed");
    assert.equal(updatedAlpha.repositories.find((repository) => repository.url === retainedRepository.url)?.id, retainedRepository.id);
    assert.deepEqual(updatedAlpha.repositories.map((repository) => repository.url).sort(), ["https://example.test/alpha-extra.git", "https://example.test/alpha.git"]);
    assert.deepEqual(updatedAlpha.deployments.map((deployment) => ({ baseBranch: deployment.baseBranch, capabilities: deployment.capabilities })), [{ baseBranch: "main", capabilities: ["configuration_read"] }]);

    const duplicateRepository = await app.inject({
      method: "PATCH",
      url: "/api/services/alpha",
      payload: { name: "Should roll back", description: "must not persist", repositories: [{ kind: "frontend", url: "https://example.test/duplicate.git" }, { kind: "backend", url: "https://example.test/duplicate.git" }], deployments: [] },
    });
    assert.equal(duplicateRepository.statusCode, 400, duplicateRepository.body);
    assert.equal((await json(duplicateRepository)).error, "duplicate_repository");
    const afterRejectedUpdate = await app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; name: string; repositories: Array<{ url: string }> }> };
    const preservedAlpha = afterRejectedUpdate.services.find((service) => service.key === "alpha")!;
    assert.equal(preservedAlpha.name, "Alpha renamed");
    assert.deepEqual(preservedAlpha.repositories.map((repository) => repository.url).sort(), ["https://example.test/alpha-extra.git", "https://example.test/alpha.git"]);

    const usedDeploymentRemoval = await app.inject({
      method: "PATCH",
      url: "/api/services/alpha",
      payload: { name: "Must roll back", description: "deployment still in use", repositories: updatedAlpha.repositories, deployments: [] },
    });
    assert.equal(usedDeploymentRemoval.statusCode, 409, usedDeploymentRemoval.body);
    assert.equal((await json(usedDeploymentRemoval)).error, "deployment_is_used_by_issues");
    const afterDeploymentRollback = await app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; name: string; deployments: unknown[] }> };
    assert.equal(afterDeploymentRollback.services.find((service) => service.key === "alpha")?.name, "Alpha renamed");
    assert.equal(afterDeploymentRollback.services.find((service) => service.key === "alpha")?.deployments.length, 1);

    const validUpdate = await app.inject({
      method: "PATCH",
      url: `/api/issues/${created.id}`,
      payload: { title: "Moved to beta", description: "", priority: "p2", type: "question", serviceKey: "beta", assigneeSubject: null, ccSubjects: [] },
    });
    assert.equal(validUpdate.statusCode, 200, validUpdate.body);
    const updatedList = await app.inject({ method: "GET", url: "/api/issues" }).then((response) => JSON.parse(response.body)) as Array<{ id: string; service: { key: string } }>;
    assert.equal(updatedList.find((item) => item.id === created.id)?.service.key, "beta");

    const boundary = "issue-pilot-test-boundary";
    const attachmentContent = "diagnostic output\n";
    const multipartBody = Buffer.from([
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="diagnostic.txt"',
      "Content-Type: text/plain",
      "",
      attachmentContent,
      `--${boundary}--`,
      "",
    ].join("\r\n"));
    const uploadResponse = await app.inject({
      method: "POST",
      url: `/api/issues/${created.id}/attachments`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody,
    });
    assert.equal(uploadResponse.statusCode, 201, uploadResponse.body);
    const uploaded = JSON.parse(uploadResponse.body) as Array<Record<string, unknown>>;
    assert.equal(uploaded[0]?.fileName, "diagnostic.txt");
    assert.equal(uploaded[0]?.sha256, createHash("sha256").update(attachmentContent).digest("hex"));
    assert.equal("objectKey" in uploaded[0]!, false);
    assert.equal("issueId" in uploaded[0]!, false);
    const attachmentDirectory = join(root, "attachments", String(created.id).toLowerCase());
    const attachmentFiles = await readdir(attachmentDirectory);
    assert.equal(attachmentFiles.length, 1);
    assert.equal((await stat(join(attachmentDirectory, attachmentFiles[0]!))).mode & 0o777, 0o600);
    const detailWithAttachment = await app.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((response) => JSON.parse(response.body)) as { attachments: Array<Record<string, unknown>> };
    assert.equal(detailWithAttachment.attachments.length, 1);
    assert.equal("objectKey" in detailWithAttachment.attachments[0]!, false);

    const invalidServiceUpdate = await app.inject({
      method: "PATCH",
      url: "/api/services/alpha",
      payload: {
        name: "Partially changed",
        description: "changed",
        repositories: [{ id: "missing-repository", kind: "frontend", url: "https://example.test/alpha.git" }],
        deployments: [{ environmentKey: "test", baseBranch: "main", capabilities: [] }],
      },
    });
    assert.equal(invalidServiceUpdate.statusCode, 400);
    assert.equal((await json(invalidServiceUpdate)).error, "invalid_repository");
    const configuration = await app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; name: string }> };
    assert.equal(configuration.services.find((service) => service.key === "alpha")?.name, "Alpha renamed");

    const interrupted = openDatabase(join(root, "issues.db"));
    await interrupted.db.transaction(async (transaction) => {
      await transaction.update(issues).set({ status: "in_progress" }).where(eq(issues.id, createdInternalId));
      await transaction.update(issueWorkspaces).set({ status: "running", lastError: null }).where(eq(issueWorkspaces.issueId, createdInternalId));
    });
    await interrupted.close();
    await app.close();
    appClosed = true;
    const restarted = await buildApi({ databaseFile: join(root, "issues.db"), stateRoot: root, runner: runner as never, logger: false });
    try {
      const recovered = await restarted.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((response) => JSON.parse(response.body)) as { status: string; workspace: { status: string; lastError: string | null } };
      assert.equal(recovered.status, "failed");
      assert.equal(recovered.workspace.status, "failed");
      assert.equal(recovered.workspace.lastError, "agent_interrupted_by_api_restart");
    } finally {
      await restarted.close();
    }
  } finally {
    if (!appClosed) await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
