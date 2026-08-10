import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";

import { openDatabase } from "../../src/db/client.ts";
import { agentSessions, issueRepositories, issues, issueWorkspaces } from "../../src/db/schema.ts";
import { buildApi } from "../../src/http/api.ts";
import { AGENT_THINKING_LEVELS } from "../../src/domain/contracts.ts";

const modelCatalog = {
  async list() {
    return [{ provider: "enterprise-ai", id: "engineering-model", contextWindow: 32_000, thinkingLevels: AGENT_THINKING_LEVELS.filter((level) => level === "medium" || level === "high") }];
  },
};

const engine = {
  enqueued: [] as string[],
  messages: [] as Array<string | undefined>,
  recordedMessages: [] as boolean[],
  closedSessions: [] as string[],
  running: new Set<string>(),
  enqueue(issueId: string, message?: string, recordMessage = true) { this.running.add(issueId); this.enqueued.push(issueId); this.messages.push(message); this.recordedMessages.push(recordMessage); },
  isRunning(issueId: string) { return this.running.has(issueId); },
  async send(issueId: string, message: string) {
    this.messages.push(message); this.enqueued.push(issueId);
    return { id: `user-${this.messages.length}`, issueId, kind: "user", message, createdAt: new Date().toISOString() };
  },
  async closeSession(issueId: string) { this.closedSessions.push(issueId); },
};

async function json(response: { body: string }): Promise<Record<string, unknown>> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

test("configuration and issue API preserves relational integrity", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-api-"));
  engine.enqueued = [];
  engine.messages = [];
  engine.recordedMessages = [];
  engine.closedSessions = [];
  engine.running.clear();
  const app = await buildApi({ databaseFile: join(root, "issues.db"), stateRoot: root, engine: engine as never, modelCatalog, logger: false });
  let appClosed = false;
  try {
    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/internal/agent-capabilities/db", payload: {} })).statusCode, 404);
    const currentUser = await app.inject({ method: "GET", url: "/api/me" });
    assert.equal(currentUser.statusCode, 200);
    const currentSubject = (await json(currentUser)).subject;
    assert.equal(typeof currentSubject, "string");
    const people = JSON.parse((await app.inject({ method: "GET", url: "/api/people" })).body) as Array<{ subject: string }>;
    assert.ok(people.some((person) => person.subject === currentSubject));

    const configurationResponse = await app.inject({ method: "GET", url: "/api/config" });
    assert.equal(configurationResponse.statusCode, 200);
    assert.equal(configurationResponse.headers["cache-control"], "private, no-store");
    assert.equal(configurationResponse.headers.pragma, "no-cache");
    const initialConfiguration = await json(configurationResponse) as { agentModels: Array<Record<string, unknown>>; environments: Array<Record<string, unknown>> };
    assert.deepEqual(initialConfiguration.environments.map((environment) => environment.key).sort(), ["dev", "prod", "test"]);
    assert.equal(initialConfiguration.environments.some((environment) => "id" in environment || "kind" in environment), false);
    assert.deepEqual(Object.keys(initialConfiguration.agentModels[0]!).sort(), ["id", "provider", "thinkingLevels"]);
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
          name: service.name,
          description: `${service.name} service`,
          repositories: service.repositoryUrls.map((url) => ({ url })),
          deployments: [
            { environmentKey: "test", baseBranch: "main", capabilities: [], agent: { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "high" } },
            ...(service.key === "beta" ? [{ environmentKey: "dev", baseBranch: "develop", capabilities: [], agent: { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "high" } }] : []),
          ],
        },
      });
      assert.equal(response.statusCode, 201, response.body);
      const createdService = await json(response);
      assert.deepEqual(Object.keys(createdService).sort(), ["key", "name"]);
      assert.deepEqual(createdService, { key: service.key, name: service.name });
    }

    for (const [key, agent, expected] of [
      ["invalid-model", { provider: "enterprise-ai", model: "missing-model", thinkingLevel: "high" }, "agent_model_not_available"],
      ["invalid-thinking", { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "off" }, "agent_thinking_level_not_supported"],
    ] as const) {
      const response = await app.inject({ method: "POST", url: "/api/services", payload: { key, name: key, description: "", repositories: [{ url: `https://example.test/${key}.git` }], deployments: [{ environmentKey: "test", baseBranch: "main", capabilities: [], agent }] } });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal((await json(response)).error, expected);
    }

    const modeled = await app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; repositories: Array<{ id: string; url: string }>; deployments: Array<{ environmentKey: string; baseBranch: string; agent: unknown }> }> };
    const alphaModel = modeled.services.find((service) => service.key === "alpha")!;
    const betaModel = modeled.services.find((service) => service.key === "beta")!;
    assert.equal(betaModel.deployments.find((deployment) => deployment.environmentKey === "dev")?.baseBranch, "develop");
    for (const field of ["id", "kind", "createdAt", "environmentIds"]) assert.equal(field in alphaModel, false);
    assert.equal(alphaModel.deployments.some((deployment) => "id" in deployment || "environmentId" in deployment), false);
    assert.equal(alphaModel.deployments[0]?.environmentKey, "test");
    assert.equal(alphaModel.repositories.some((repository) => "kind" in repository), false);
    assert.deepEqual(alphaModel.repositories.map((repository) => repository.url).sort(), ["https://example.test/alpha-shared.git", "https://example.test/alpha.git"]);
    assert.deepEqual(alphaModel.deployments[0]?.agent, { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "high" });

    assert.deepEqual(modeled.services.map((service) => service.key), ["alpha", "beta"]);
    const removedOrderEndpoint = await app.inject({ method: "PUT", url: "/api/services/order", payload: { serviceKeys: ["beta", "alpha"] } });
    assert.equal(removedOrderEndpoint.statusCode, 404);

    const invalidSubject = await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Unknown assignee",
        description: "",
        priority: "p2",
        type: "smart_analysis",
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
        type: "smart_analysis",
        environmentKey: "test",
        serviceKey: "alpha",
        assigneeSubject: null,
        ccSubjects: [],
      },
    });
    assert.equal(invalidPriority.statusCode, 400);
    assert.equal((await json(invalidPriority)).error, "invalid_priority");

    const invalidDevType = await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Dev question",
        description: "",
        priority: "p2",
        type: "smart_analysis",
        environmentKey: "dev",
        serviceKey: "beta",
        assigneeSubject: null,
        ccSubjects: [],
      },
    });
    assert.equal(invalidDevType.statusCode, 400);
    assert.equal((await json(invalidDevType)).error, "invalid_issue_type_for_environment");
    assert.deepEqual(await app.inject({ method: "GET", url: "/api/issues" }).then((response) => JSON.parse(response.body)), []);

    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Valid issue",
        description: "Investigate alpha",
        priority: "p1",
        type: "smart_analysis",
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
    const failedRun = openDatabase(join(root, "issues.db"));
    await failedRun.db.update(issues).set({ status: "open" }).where(eq(issues.key, String(created.id)));
    await failedRun.db.update(issueWorkspaces).set({ status: "failed" }).where(eq(issueWorkspaces.issueId, createdInternalId));
    await failedRun.close();
    const retryResponses = await Promise.all([
      app.inject({ method: "POST", url: `/api/issues/${created.id}/retry` }),
      app.inject({ method: "POST", url: `/api/issues/${created.id}/retry` }),
    ]);
    assert.deepEqual(retryResponses.map((response) => response.statusCode).sort(), [202, 409]);
    assert.equal(engine.enqueued.filter((id) => id === createdInternalId).length, 2);
    const retried = await app.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((response) => JSON.parse(response.body)) as { status: string };
    assert.equal(retried.status, "open");
    engine.running.delete(createdInternalId);
    const prematureResolve = await app.inject({ method: "PATCH", url: `/api/issues/${created.id}/status`, payload: { status: "resolved" } });
    assert.equal(prematureResolve.statusCode, 409);
    const direct = openDatabase(join(root, "issues.db"));
    await direct.db.update(issues).set({ status: "pending" }).where(eq(issues.key, String(created.id)));
    await direct.close();
    const resolved = await app.inject({ method: "PATCH", url: `/api/issues/${created.id}/status`, payload: { status: "resolved" } });
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.equal((await json(resolved)).status, "resolved");
    for (const [url, payload] of [
      [`/api/issues/${created.id}/retry`, undefined],
      [`/api/issues/${created.id}/sync`, undefined],
      [`/api/issues/${created.id}/agent-messages`, { message: "must reopen first" }],
    ] as const) {
      const rejected = await app.inject({ method: "POST", url, ...(payload ? { payload } : {}) });
      assert.equal(rejected.statusCode, 409, rejected.body);
    }
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
    assert.equal((await app.inject({ method: "POST", url: `/api/issues/${created.id}/agent-abort` })).statusCode, 404);

    const concurrentPayload = (title: string) => ({
      title,
      description: "",
      priority: "p2",
      type: "smart_analysis",
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
    engine.running.clear();

    const invalidIssuePath = await app.inject({ method: "GET", url: "/api/issues/not-an-issue" });
    assert.equal(invalidIssuePath.statusCode, 404);

    const detailResponse = await app.inject({ method: "GET", url: `/api/issues/${created.id}` });
    assert.equal(detailResponse.statusCode, 200, detailResponse.body);
    const detail = await json(detailResponse);
    assert.equal(detail.title, "Valid issue");
    assert.equal((detail.service as { key: string }).key, "alpha");
    assert.equal("affectedModules" in detail, false);
    assert.equal("scopeCandidates" in detail, false);
    assert.equal("version" in detail, false);
    assert.equal("agentSession" in detail, false);
    const workspaceStats = await app.inject({ method: "GET", url: "/api/workspaces/stats" });
    assert.equal(workspaceStats.statusCode, 200, workspaceStats.body);
    const workspaceStatsBody = await json(workspaceStats) as { totalBytes: number; policy: Record<string, unknown>; workspaces: Array<Record<string, unknown>> };
    assert.equal(typeof workspaceStatsBody.totalBytes, "number");
    assert.deepEqual(Object.keys(workspaceStatsBody.policy).sort(), ["highWaterBytes", "maintenanceIntervalMinutes", "retentionHours", "targetBytes"]);
    assert.equal(workspaceStatsBody.workspaces.some((workspace) => "issueId" in workspace), false);

    const staleSessionFile = join(root, "historical-session.jsonl");
    await writeFile(staleSessionFile, "{}\n", "utf8");
    const staleSession = openDatabase(join(root, "issues.db"));
    await staleSession.db.transaction(async (transaction) => {
      await transaction.update(issueWorkspaces).set({ status: "ready" }).where(eq(issueWorkspaces.issueId, createdInternalId));
      await transaction.insert(agentSessions).values({ issueId: createdInternalId, sessionFile: staleSessionFile, workspacePath: root });
      await transaction.insert(issueRepositories).values({ issueId: createdInternalId, url: "https://example.test/alpha.git", baseBranch: "main", workingBranch: "hotfix", localPath: join(root, "workspaces", String(created.id).toLowerCase(), "alpha") });
    });
    await staleSession.close();
    const staleSessionDetail = await app.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((response) => JSON.parse(response.body)) as { repositories: Array<Record<string, unknown>>; workspace: { retryable: boolean } };
    assert.equal("agentSession" in staleSessionDetail, false);
    assert.deepEqual(Object.keys(staleSessionDetail.repositories[0]!).sort(), ["baseBranch", "url", "workingBranch"]);
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
        repositories: [{ id: retainedRepository.id, url: retainedRepository.url }, { url: "https://example.test/alpha-extra.git" }],
        deployments: [{ environmentKey: "test", baseBranch: "main", capabilities: ["playwright", "nacos", "db", "redis", "mq", "es", "sls"], agent: { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "high" }, nacos: { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["alpha-test.yaml"], username: "operator", password: "nacos-secret" }, db: { url: "mysql://db.example.test:3306/alpha", username: "readonly", password: "db-secret" }, redis: { host: "192.168.27.122", port: 6379, username: "", password: "redis-secret", database: 0 }, mq: { host: "192.168.27.122", port: 5672, managementPort: 15672, username: "admin", password: "mq-secret", virtualHost: "/" }, es: { url: "http://es-6.example.test", username: "", password: "" }, sls: { accessKeyId: "fixture-key", accessKeySecret: "sls-secret", region: "cn-test", project: "alpha-test", logstores: ["application"] }, playwright: { baseUrl: "https://alpha.example.test/admin/login", username: "operator", password: "deployment-secret" } }],
      },
    });
    assert.equal(repositoryUpdate.statusCode, 200, repositoryUpdate.body);
    assert.equal(engine.closedSessions.includes(createdInternalId), true);
    const afterRepositoryUpdate = await app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; name: string; deployments: Array<{ baseBranch: string; capabilities: string[]; nacos: { dataIds: string[]; password: string }; db: { url: string; password: string }; sls: { accessKeySecret: string }; playwright: { baseUrl: string; username: string; password: string } | null }>; repositories: Array<{ id: string; url: string }> }> };
    const updatedAlpha = afterRepositoryUpdate.services.find((service) => service.key === "alpha")!;
    assert.equal(updatedAlpha.name, "Alpha renamed");
    assert.equal(updatedAlpha.repositories.find((repository) => repository.url === retainedRepository.url)?.id, retainedRepository.id);
    assert.deepEqual(updatedAlpha.repositories.map((repository) => repository.url).sort(), ["https://example.test/alpha-extra.git", "https://example.test/alpha.git"]);
    assert.deepEqual(updatedAlpha.deployments.map((deployment) => ({ baseBranch: deployment.baseBranch, capabilities: deployment.capabilities, playwright: deployment.playwright })), [{ baseBranch: "main", capabilities: ["playwright", "nacos", "db", "redis", "mq", "es", "sls"], playwright: { baseUrl: "https://alpha.example.test/admin/login", username: "operator", password: "deployment-secret" } }]);
    assert.match(JSON.stringify(afterRepositoryUpdate), /deployment-secret/);
    assert.deepEqual(updatedAlpha.deployments[0]?.nacos.dataIds, ["alpha-test.yaml"]);
    assert.equal(updatedAlpha.deployments[0]?.nacos.password, "nacos-secret");
    assert.equal(updatedAlpha.deployments[0]?.db.url, "mysql://db.example.test:3306/alpha");
    assert.equal(updatedAlpha.deployments[0]?.db.password, "db-secret");
    assert.equal(updatedAlpha.deployments[0]?.sls.accessKeySecret, "sls-secret");

    const missingDbPassword = await app.inject({
      method: "PATCH",
      url: "/api/services/alpha",
      payload: { name: "Invalid DB", description: "", repositories: updatedAlpha.repositories, deployments: [{ environmentKey: "test", baseBranch: "main", capabilities: ["db"], agent: { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "high" }, db: { url: "mysql://db.example.test:3306/alpha", username: "readonly", password: "" } }] },
    });
    assert.equal(missingDbPassword.statusCode, 400, missingDbPassword.body);
    assert.equal((await json(missingDbPassword)).error, "invalid_db_password");
    const clearedOptionalCredentials = await app.inject({
      method: "PATCH",
      url: "/api/services/alpha",
      payload: {
        name: "Alpha renamed",
        description: "cleared optional credentials",
        repositories: updatedAlpha.repositories,
        deployments: [{
          environmentKey: "test", baseBranch: "main", capabilities: ["playwright", "nacos", "es"],
          agent: { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "high" },
          nacos: { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["alpha-test.yaml"], username: "", password: "" },
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
    assert.equal(clearedDeployment.playwright.password, undefined);
    assert.equal(clearedDeployment.es.url, "http://es-6.example.test/proxy");
    engine.running.add(createdInternalId);
    const runningServiceUpdate = await app.inject({ method: "PATCH", url: "/api/services/alpha", payload: {} });
    assert.equal(runningServiceUpdate.statusCode, 409, runningServiceUpdate.body);
    assert.equal((await json(runningServiceUpdate)).error, "service_has_running_issues");
    engine.running.delete(createdInternalId);

    const duplicateRepository = await app.inject({
      method: "PATCH",
      url: "/api/services/alpha",
      payload: { name: "Should roll back", description: "must not persist", repositories: [{ url: "https://example.test/duplicate.git" }, { url: "https://example.test/duplicate.git" }], deployments: [] },
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
      payload: { title: "Moved to beta", description: "", priority: "p2", type: "smart_analysis", serviceKey: "beta", assigneeSubject: null, ccSubjects: [] },
    });
    assert.equal(validUpdate.statusCode, 200, validUpdate.body);
    const updatedList = await app.inject({ method: "GET", url: "/api/issues" }).then((response) => JSON.parse(response.body)) as Array<{ id: string; service: { key: string } }>;
    assert.equal(updatedList.find((item) => item.id === created.id)?.service.key, "beta");

    const createBoundary = "issue-pilot-create-with-attachment";
    const initialIssue = {
      title: "Issue with initial evidence",
      description: "Inspect the attached evidence",
      priority: "p2",
      type: "smart_analysis",
      environmentKey: "test",
      serviceKey: "alpha",
      assigneeSubject: null,
      ccSubjects: [],
    };
    const createWithAttachmentBody = Buffer.from([
      `--${createBoundary}`,
      'Content-Disposition: form-data; name="issue"',
      "",
      JSON.stringify(initialIssue),
      `--${createBoundary}`,
      'Content-Disposition: form-data; name="files"; filename="initial.txt"',
      "Content-Type: text/plain",
      "",
      "initial evidence",
      `--${createBoundary}--`,
      "",
    ].join("\r\n"));
    const enqueueCountBeforeMultipartCreate = engine.enqueued.length;
    const createWithAttachment = await app.inject({
      method: "POST",
      url: "/api/issues",
      headers: { "content-type": `multipart/form-data; boundary=${createBoundary}` },
      payload: createWithAttachmentBody,
    });
    assert.equal(createWithAttachment.statusCode, 201, createWithAttachment.body);
    assert.equal(engine.enqueued.length, enqueueCountBeforeMultipartCreate + 1);
    const issueWithAttachment = await json(createWithAttachment);
    const createdWithAttachmentDetail = await app.inject({ method: "GET", url: `/api/issues/${issueWithAttachment.id}` }).then((response) => JSON.parse(response.body)) as { attachments: Array<{ fileName: string; sha256: string }> };
    assert.deepEqual(createdWithAttachmentDetail.attachments.map(({ fileName }) => fileName), ["initial.txt"]);
    assert.equal(createdWithAttachmentDetail.attachments[0]?.sha256, createHash("sha256").update("initial evidence").digest("hex"));
    engine.running.delete(engine.enqueued.at(-1)!);

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
    const detailWithAttachment = await app.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((response) => JSON.parse(response.body)) as { attachments: Array<Record<string, unknown>> };
    assert.equal(detailWithAttachment.attachments.length, 1);
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
    assert.match(engine.messages.at(-1) ?? "", /sessions\/issue-20260810-001\/runtime\/attachments/);
    assert.equal(engine.recordedMessages.at(-1), false);
    engine.running.delete(createdInternalId);

    const largeBoundary = "issue-pilot-large-attachment";
    const largeContent = Buffer.alloc(1_100_000, "a");
    const largeUpload = await app.inject({
      method: "POST",
      url: `/api/issues/${created.id}/attachments`,
      headers: { "content-type": `multipart/form-data; boundary=${largeBoundary}` },
      payload: Buffer.concat([
        Buffer.from(`--${largeBoundary}\r\nContent-Disposition: form-data; name="files"; filename="large.txt"\r\nContent-Type: text/plain\r\n\r\n`),
        largeContent,
        Buffer.from(`\r\n--${largeBoundary}--\r\n`),
      ]),
    });
    assert.equal(largeUpload.statusCode, 201, largeUpload.body);
    const [largeAttachment] = await json(largeUpload) as unknown as Array<{ id: string }>;

    const oversizedBoundary = "issue-pilot-oversized-attachment";
    const oversizedUpload = await app.inject({
      method: "POST",
      url: `/api/issues/${created.id}/attachments`,
      headers: { "content-type": `multipart/form-data; boundary=${oversizedBoundary}` },
      payload: Buffer.concat([
        Buffer.from(`--${oversizedBoundary}\r\nContent-Disposition: form-data; name="files"; filename="oversized.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        Buffer.alloc(20 * 1024 * 1024 + 1),
        Buffer.from(`\r\n--${oversizedBoundary}--\r\n`),
      ]),
    });
    assert.equal(oversizedUpload.statusCode, 413, oversizedUpload.body);
    assert.equal((await json(oversizedUpload)).error, "attachment_limit_exceeded");

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
    assert.equal((await readdir(attachmentDirectory)).length, 12);

    const deleteAttachment = await app.inject({ method: "DELETE", url: `/api/issues/${created.id}/attachments`, payload: { attachmentIds: [uploaded[0]!.id, largeAttachment!.id, ...additionalAttachments.map(({ id }) => id)] } });
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
        repositories: [{ id: "missing-repository", url: "https://example.test/alpha.git" }],
        deployments: [{ environmentKey: "test", baseBranch: "main", capabilities: [], agent: { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "high" } }],
      },
    });
    assert.equal(invalidServiceUpdate.statusCode, 400);
    assert.equal((await json(invalidServiceUpdate)).error, "invalid_repository");
    const configuration = await app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; name: string }> };
    assert.equal(configuration.services.find((service) => service.key === "alpha")?.name, "Alpha renamed");

    const devIssue = await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: { title: "Dev defect", description: "", priority: "p2", type: "defect_fix", environmentKey: "dev", serviceKey: "beta", assigneeSubject: null, ccSubjects: [] },
    });
    assert.equal(devIssue.statusCode, 201, devIssue.body);
    const devIssueKey = String((await json(devIssue)).id);
    engine.running.delete(engine.enqueued.at(-1)!);
    const invalidDevUpdate = await app.inject({
      method: "PATCH",
      url: `/api/issues/${devIssueKey}`,
      payload: { title: "Dev question", description: "", priority: "p2", type: "smart_analysis", serviceKey: "beta", assigneeSubject: null, ccSubjects: [] },
    });
    assert.equal(invalidDevUpdate.statusCode, 400);
    assert.equal((await json(invalidDevUpdate)).error, "invalid_issue_type_for_environment");

    const interrupted = openDatabase(join(root, "issues.db"));
    await interrupted.db.transaction(async (transaction) => {
      await transaction.update(issues).set({ status: "in_progress" }).where(eq(issues.id, createdInternalId));
      await transaction.update(issueWorkspaces).set({ status: "running", lastError: null }).where(eq(issueWorkspaces.issueId, createdInternalId));
    });
    await interrupted.close();
    await app.close();
    appClosed = true;
    const restarted = await buildApi({ databaseFile: join(root, "issues.db"), stateRoot: root, engine: engine as never, modelCatalog, logger: false });
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
