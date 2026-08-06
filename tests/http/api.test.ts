import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";

import { openDatabase } from "../../src/db/client.ts";
import { agentSessions, issueAgentResults, issues, issueWorkspaces } from "../../src/db/schema.ts";
import { buildApi } from "../../src/http/api.ts";

const engine = {
  enqueued: [] as string[],
  messages: [] as Array<string | undefined>,
  recordedMessages: [] as boolean[],
  invalidated: [] as string[],
  running: new Set<string>(),
  enqueue(issueId: string, message?: string, recordMessage = true) { this.enqueued.push(issueId); this.messages.push(message); this.recordedMessages.push(recordMessage); },
  isRunning(issueId: string) { return this.running.has(issueId); },
  async send(issueId: string, message: string) {
    this.messages.push(message); this.enqueued.push(issueId);
    return { id: `user-${this.messages.length}`, issueId, kind: "user", message, createdAt: new Date().toISOString() };
  },
  async abort(issueId: string) { return this.running.has(issueId); },
  async invalidatePolicy(issueId: string) { this.invalidated.push(issueId); return true; },
};

async function json(response: { body: string }): Promise<Record<string, unknown>> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

test("configuration and issue API preserves relational integrity", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-api-"));
  engine.enqueued = [];
  engine.messages = [];
  engine.recordedMessages = [];
  engine.invalidated = [];
  engine.running.clear();
  const app = await buildApi({ databaseFile: join(root, "issues.db"), stateRoot: root, engine: engine as never, logger: false });
  let appClosed = false;
  try {
    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);

    const configurationResponse = await app.inject({ method: "GET", url: "/api/config" });
    assert.equal(configurationResponse.statusCode, 200);
    assert.equal(configurationResponse.headers["cache-control"], "private, no-store");
    assert.equal(configurationResponse.headers.pragma, "no-cache");
    const configuredEnvironments = (await json(configurationResponse)).environments as Array<{ key: string; name: string }>;
    assert.deepEqual(configuredEnvironments.map((environment) => environment.key).sort(), ["development", "production", "test"]);
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
          deployments: [
            { environmentKey: "test", baseBranch: "main", capabilities: [], ...(service.key === "alpha" ? { agent: { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "high" } } : {}) },
            ...(service.key === "beta" ? [{ environmentKey: "development", baseBranch: "develop", capabilities: [] }] : []),
          ],
        },
      });
      assert.equal(response.statusCode, 201, response.body);
    }

    const modeled = await app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ id: string; key: string; repositories: Array<{ id: string; kind: string; url: string }>; deployments: Array<{ agent: unknown }> }> };
    const alphaModel = modeled.services.find((service) => service.key === "alpha")!;
    assert.equal("kind" in alphaModel, false);
    assert.deepEqual(alphaModel.repositories.map((repository) => repository.kind).sort(), ["backend", "frontend"]);
    assert.deepEqual(alphaModel.repositories.map((repository) => repository.url).sort(), ["https://example.test/alpha-shared.git", "https://example.test/alpha.git"]);
    assert.deepEqual(alphaModel.deployments[0]?.agent, { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "high" });

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

    const invalidDevelopmentType = await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Development question",
        description: "",
        priority: "p2",
        type: "question",
        environmentKey: "development",
        serviceKey: "beta",
        assigneeSubject: null,
        ccSubjects: [],
      },
    });
    assert.equal(invalidDevelopmentType.statusCode, 400);
    assert.equal((await json(invalidDevelopmentType)).error, "invalid_issue_type_for_environment");
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
        assigneeSubject: "zjj3753@xianhengguoji.com",
        ccSubjects: [],
      },
    });
    assert.equal(createdResponse.statusCode, 201, createdResponse.body);
    const created = await json(createdResponse);
    assert.match(String(created.id), /^ISSUE-[0-9]{8}-001$/);
    assert.equal(engine.enqueued.length, 1);
    const createdInternalId = engine.enqueued[0]!;
    engine.running.add(createdInternalId);
    const runningRetry = await app.inject({ method: "POST", url: `/api/issues/${created.id}/retry` });
    assert.equal(runningRetry.statusCode, 409);
    assert.equal((await json(runningRetry)).error, "issue_already_running");
    engine.running.delete(createdInternalId);
    const retryResponse = await app.inject({ method: "POST", url: `/api/issues/${created.id}/retry` });
    assert.equal(retryResponse.statusCode, 202, retryResponse.body);
    assert.equal(engine.enqueued.filter((id) => id === createdInternalId).length, 2);
    const retried = await app.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((response) => JSON.parse(response.body)) as { status: string };
    assert.equal(retried.status, "in_progress");
    const prematureResolve = await app.inject({ method: "PATCH", url: `/api/issues/${created.id}/status`, payload: { status: "resolved" } });
    assert.equal(prematureResolve.statusCode, 409);
    const direct = openDatabase(join(root, "issues.db"));
    await direct.db.update(issues).set({ status: "pending" }).where(eq(issues.key, String(created.id)));
    const unverifiedResolve = await app.inject({ method: "PATCH", url: `/api/issues/${created.id}/status`, payload: { status: "resolved" } });
    assert.equal(unverifiedResolve.statusCode, 409, unverifiedResolve.body);
    assert.equal((await json(unverifiedResolve)).error, "issue_verification_required");
    await direct.db.insert(issueAgentResults).values({ issueId: createdInternalId, outcome: "resolved", summary: "Verified", verification: ["npm test passed"], policyVersion: 12 });
    await direct.close();
    const resolved = await app.inject({ method: "PATCH", url: `/api/issues/${created.id}/status`, payload: { status: "resolved" } });
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.equal((await json(resolved)).status, "resolved");
    const reopened = await app.inject({ method: "PATCH", url: `/api/issues/${created.id}/status`, payload: { status: "open" } });
    assert.equal(reopened.statusCode, 200, reopened.body);
    assert.equal((await json(reopened)).status, "open");
    const enqueueCountBeforeComment = engine.enqueued.length;
    const followUp = await app.inject({ method: "POST", url: `/api/issues/${created.id}/comments`, payload: { body: "A note for other users" } });
    assert.equal(followUp.statusCode, 201, followUp.body);
    const afterFollowUp = await app.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((response) => JSON.parse(response.body)) as { status: string; comments: Array<{ body: string }> };
    assert.equal(afterFollowUp.status, "open");
    assert.deepEqual(afterFollowUp.comments.map((comment) => comment.body), ["A note for other users"]);
    assert.equal(engine.enqueued.length, enqueueCountBeforeComment);
    const agentMessage = await app.inject({ method: "POST", url: `/api/issues/${created.id}/agent-messages`, payload: { message: "Check the latest evidence" } });
    assert.equal(agentMessage.statusCode, 202, agentMessage.body);
    assert.equal(agentMessage.body, "");
    assert.equal(engine.messages.at(-1), "Check the latest evidence");
    assert.equal((await app.inject({ method: "POST", url: `/api/issues/${created.id}/agent-messages`, payload: { message: "" } })).statusCode, 400);
    engine.running.add(createdInternalId);
    assert.equal((await app.inject({ method: "POST", url: `/api/issues/${created.id}/agent-abort` })).statusCode, 202);
    engine.running.delete(createdInternalId);
    assert.equal((await app.inject({ method: "POST", url: `/api/issues/${created.id}/agent-abort` })).statusCode, 409);

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
    assert.deepEqual(staleSessionDetail.agentSession, { sessionId: "historical-session" });
    assert.equal(staleSessionDetail.workspace.retryable, false);
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
        deployments: [{ environmentKey: "test", baseBranch: "main", capabilities: ["playwright", "nacos", "db", "redis", "mq", "es", "sls"], nacos: { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", username: "operator", password: "nacos-secret" }, db: { url: "jdbc:mysql://db.example.test:3306/alpha?useUnicode=true", username: "readonly", password: "db-secret" }, redis: { host: "192.168.27.122", port: 6379, username: "", password: "redis-secret", database: 0 }, mq: { host: "192.168.27.122", port: 5672, managementPort: 15672, username: "admin", password: "mq-secret", virtualHost: "/" }, es: { url: "http://es-6.example.test", username: "", password: "" }, sls: { accessKeyId: "fixture-key", accessKeySecret: "sls-secret", region: "cn-test", project: "alpha-test", logstores: ["application"] }, playwright: { baseUrl: "https://alpha.example.test/admin/login", username: "operator", password: "deployment-secret" } }],
      },
    });
    assert.equal(repositoryUpdate.statusCode, 200, repositoryUpdate.body);
    assert.equal(engine.invalidated.includes(createdInternalId), true);
    const afterRepositoryUpdate = await app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; name: string; deployments: Array<{ baseBranch: string; capabilities: string[]; nacos: { password: string }; db: { url: string; password: string }; sls: { accessKeySecret: string }; playwright: { baseUrl: string; username: string; password: string } | null }>; repositories: Array<{ id: string; kind: string; url: string }> }> };
    const updatedAlpha = afterRepositoryUpdate.services.find((service) => service.key === "alpha")!;
    assert.equal(updatedAlpha.name, "Alpha renamed");
    assert.equal(updatedAlpha.repositories.find((repository) => repository.url === retainedRepository.url)?.id, retainedRepository.id);
    assert.deepEqual(updatedAlpha.repositories.map((repository) => repository.url).sort(), ["https://example.test/alpha-extra.git", "https://example.test/alpha.git"]);
    assert.deepEqual(updatedAlpha.deployments.map((deployment) => ({ baseBranch: deployment.baseBranch, capabilities: deployment.capabilities, playwright: deployment.playwright })), [{ baseBranch: "main", capabilities: ["playwright", "nacos", "db", "redis", "mq", "es", "sls"], playwright: { baseUrl: "https://alpha.example.test/admin/login", username: "operator", password: "deployment-secret" } }]);
    assert.match(JSON.stringify(afterRepositoryUpdate), /deployment-secret/);
    assert.equal(updatedAlpha.deployments[0]?.nacos.password, "nacos-secret");
    assert.equal(updatedAlpha.deployments[0]?.db.url, "mysql://db.example.test:3306/alpha?useUnicode=true");
    assert.equal(updatedAlpha.deployments[0]?.db.password, "db-secret");
    assert.equal(updatedAlpha.deployments[0]?.sls.accessKeySecret, "sls-secret");

    const missingDbPassword = await app.inject({
      method: "PATCH",
      url: "/api/services/alpha",
      payload: { name: "Invalid DB", description: "", repositories: updatedAlpha.repositories, deployments: [{ environmentKey: "test", baseBranch: "main", capabilities: ["db"], db: { url: "mysql://db.example.test:3306/alpha", username: "readonly" } }] },
    });
    assert.equal(missingDbPassword.statusCode, 400, missingDbPassword.body);
    assert.equal((await json(missingDbPassword)).error, "invalid_db_password");
    const incompleteEsCredentials = await app.inject({
      method: "PATCH",
      url: "/api/services/alpha",
      payload: { name: "Invalid ES", description: "", repositories: updatedAlpha.repositories, deployments: [{ environmentKey: "test", baseBranch: "main", capabilities: ["es"], es: { url: "http://es.example.test", username: "reader" } }] },
    });
    assert.equal(incompleteEsCredentials.statusCode, 400, incompleteEsCredentials.body);
    assert.equal((await json(incompleteEsCredentials)).error, "invalid_es_credentials");
    const incompleteBrowserCredentials = await app.inject({
      method: "PATCH",
      url: "/api/services/alpha",
      payload: { name: "Invalid browser", description: "", repositories: updatedAlpha.repositories, deployments: [{ environmentKey: "test", baseBranch: "main", capabilities: ["playwright"], playwright: { baseUrl: "https://alpha.example.test", password: "password-only" } }] },
    });
    assert.equal(incompleteBrowserCredentials.statusCode, 400, incompleteBrowserCredentials.body);
    assert.equal((await json(incompleteBrowserCredentials)).error, "invalid_browser_credentials");

    const clearedOptionalCredentials = await app.inject({
      method: "PATCH",
      url: "/api/services/alpha",
      payload: {
        name: "Alpha renamed",
        description: "cleared optional credentials",
        repositories: updatedAlpha.repositories,
        deployments: [{
          environmentKey: "test", baseBranch: "main", capabilities: ["playwright", "nacos", "es"],
          nacos: { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", username: "", password: "" },
          es: { url: "http://es-6.example.test/proxy", username: "", password: "" },
          playwright: { baseUrl: "https://alpha.example.test/admin/login", username: "", password: "" },
        }],
      },
    });
    assert.equal(clearedOptionalCredentials.statusCode, 200, clearedOptionalCredentials.body);
    const afterCredentialClear = await app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; deployments: Array<{ nacos: Record<string, unknown>; es: Record<string, unknown>; playwright: Record<string, unknown> }> }> };
    const clearedDeployment = afterCredentialClear.services.find((service) => service.key === "alpha")!.deployments[0]!;
    assert.equal(clearedDeployment.nacos.password, undefined);
    assert.equal(clearedDeployment.es.password, undefined);
    assert.equal(clearedDeployment.playwright.password, "");
    assert.equal(clearedDeployment.es.url, "http://es-6.example.test/proxy");
    engine.running.add(createdInternalId);
    const runningServiceUpdate = await app.inject({ method: "PATCH", url: "/api/services/alpha", payload: {} });
    assert.equal(runningServiceUpdate.statusCode, 409, runningServiceUpdate.body);
    assert.equal((await json(runningServiceUpdate)).error, "service_has_running_issues");
    engine.running.delete(createdInternalId);

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
    assert.equal("scanStatus" in uploaded[0]!, false);
    const attachmentDirectory = join(root, "attachments", String(created.id).toLowerCase());
    const attachmentFiles = await readdir(attachmentDirectory);
    assert.equal(attachmentFiles.length, 1);
    assert.equal((await stat(join(attachmentDirectory, attachmentFiles[0]!))).mode & 0o777, 0o600);
    const detailWithAttachment = await app.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((response) => JSON.parse(response.body)) as { attachments: Array<Record<string, unknown>>; agentResult: unknown };
    assert.equal(detailWithAttachment.attachments.length, 1);
    assert.equal(detailWithAttachment.agentResult, null);
    assert.equal("objectKey" in detailWithAttachment.attachments[0]!, false);
    assert.equal("scanStatus" in detailWithAttachment.attachments[0]!, false);
    const attachmentPreview = await app.inject({ method: "GET", url: `/api/issues/${created.id}/attachments/${uploaded[0]!.id}` });
    assert.equal(attachmentPreview.statusCode, 200, attachmentPreview.body);
    assert.equal(attachmentPreview.body, attachmentContent);
    assert.match(String(attachmentPreview.headers["content-type"]), /^text\/plain/);
    assert.match(String(attachmentPreview.headers["content-disposition"]), /^inline;/);
    assert.equal(attachmentPreview.headers["cache-control"], "private, no-store");
    assert.equal((await app.inject({ method: "GET", url: `/api/issues/${created.id}/attachments/missing` })).statusCode, 404);
    const attachmentPath = join(attachmentDirectory, attachmentFiles[0]!);
    await writeFile(attachmentPath, "diagnostic outpvt\n", "utf8");
    assert.equal((await app.inject({ method: "GET", url: `/api/issues/${created.id}/attachments/${uploaded[0]!.id}` })).statusCode, 500);
    await writeFile(attachmentPath, attachmentContent, "utf8");
    const syncResponse = await app.inject({ method: "POST", url: `/api/issues/${created.id}/sync` });
    assert.equal(syncResponse.statusCode, 202, syncResponse.body);
    assert.match(engine.messages.at(-1) ?? "", /Issue metadata was updated/);
    assert.match(engine.messages.at(-1) ?? "", /diagnostic\.txt/);
    assert.match(engine.messages.at(-1) ?? "", /attachment_read/);
    assert.equal(engine.recordedMessages.at(-1), false);

    const excessiveBoundary = "issue-pilot-excessive-attachments";
    const excessiveBody = Buffer.from([
      ...Array.from({ length: 10 }, (_, index) => [
        `--${excessiveBoundary}`,
        `Content-Disposition: form-data; name="files"; filename="extra-${index}.txt"`,
        "Content-Type: text/plain",
        "",
        `extra-${index}`,
      ]).flat(),
      `--${excessiveBoundary}--`,
      "",
    ].join("\r\n"));
    const excessiveUpload = await app.inject({
      method: "POST",
      url: `/api/issues/${created.id}/attachments`,
      headers: { "content-type": `multipart/form-data; boundary=${excessiveBoundary}` },
      payload: excessiveBody,
    });
    assert.equal(excessiveUpload.statusCode, 201, excessiveUpload.body);
    const additionalAttachments = await json(excessiveUpload) as unknown as Array<{ id: string }>;
    assert.equal(additionalAttachments.length, 10);
    assert.equal((await readdir(attachmentDirectory)).length, 11);

    const deleteAttachment = await app.inject({ method: "DELETE", url: `/api/issues/${created.id}/attachments`, payload: { attachmentIds: [uploaded[0]!.id, ...additionalAttachments.map(({ id }) => id)] } });
    assert.equal(deleteAttachment.statusCode, 204, deleteAttachment.body);
    assert.equal((await readdir(attachmentDirectory)).length, 0);
    const detailWithoutAttachment = await app.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((response) => JSON.parse(response.body)) as { attachments: unknown[] };
    assert.equal(detailWithoutAttachment.attachments.length, 0);
    const deleteMissingAttachment = await app.inject({ method: "DELETE", url: `/api/issues/${created.id}/attachments`, payload: { attachmentIds: [uploaded[0]!.id] } });
    assert.equal(deleteMissingAttachment.statusCode, 404, deleteMissingAttachment.body);

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

    const developmentIssue = await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: { title: "Development defect", description: "", priority: "p2", type: "incident", environmentKey: "development", serviceKey: "beta", assigneeSubject: null, ccSubjects: [] },
    });
    assert.equal(developmentIssue.statusCode, 201, developmentIssue.body);
    const developmentIssueKey = String((await json(developmentIssue)).id);
    const invalidDevelopmentUpdate = await app.inject({
      method: "PATCH",
      url: `/api/issues/${developmentIssueKey}`,
      payload: { title: "Development question", description: "", priority: "p2", type: "smart_analysis", serviceKey: "beta", assigneeSubject: null, ccSubjects: [] },
    });
    assert.equal(invalidDevelopmentUpdate.statusCode, 400);
    assert.equal((await json(invalidDevelopmentUpdate)).error, "invalid_issue_type_for_environment");

    const interrupted = openDatabase(join(root, "issues.db"));
    await interrupted.db.transaction(async (transaction) => {
      await transaction.update(issues).set({ status: "in_progress" }).where(eq(issues.id, createdInternalId));
      await transaction.update(issueWorkspaces).set({ status: "running", lastError: null }).where(eq(issueWorkspaces.issueId, createdInternalId));
    });
    await interrupted.close();
    await app.close();
    appClosed = true;
    const restarted = await buildApi({ databaseFile: join(root, "issues.db"), stateRoot: root, engine: engine as never, logger: false });
    try {
      const recovered = await restarted.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((response) => JSON.parse(response.body)) as { status: string; workspace: { status: string; lastError: string | null } };
      assert.equal(recovered.status, "open");
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
