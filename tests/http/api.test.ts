import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openDatabase } from "../../src/db/client.ts";
import { agentSessions, issueRepositories, issues, issueWorkspaces, serviceDeployments, services } from "../../src/db/schema.ts";
import { buildApi } from "../../src/http/api.ts";
import { AGENT_THINKING_LEVELS } from "../../src/domain/contracts.ts";
import { issueAttachmentRoot } from "../../src/workspace/state.ts";

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
  reservations: new Set<string>(),
  closeSessionHook: undefined as undefined | ((issueId: string) => Promise<void>),
  enqueue(issueId: string, message?: string, recordMessage = true) { this.running.add(issueId); this.enqueued.push(issueId); this.messages.push(message); this.recordedMessages.push(recordMessage); },
  isRunning(issueId: string) { return this.running.has(issueId); },
  async runExclusive<T>(issueIds: string[], operation: (reservation: { enqueue(issueId: string, message?: string, recordMessage?: boolean): void; closeSession(issueId: string): Promise<void> }) => Promise<T>): Promise<T> {
    const reserved = [...new Set(issueIds)];
    if (reserved.some((issueId) => this.running.has(issueId) || this.reservations.has(issueId))) throw new Error("issue_already_running");
    for (const issueId of reserved) this.reservations.add(issueId);
    try {
      return await operation({
        enqueue: (issueId, message, recordMessage = true) => this.enqueue(issueId, message, recordMessage),
        closeSession: (issueId) => this.closeSession(issueId),
      });
    } finally {
      for (const issueId of reserved) this.reservations.delete(issueId);
    }
  },
  async send(issueId: string, message: string) {
    if (this.reservations.has(issueId)) throw new Error("issue_already_running");
    this.messages.push(message); this.enqueued.push(issueId);
    return { id: `user-${this.messages.length}`, issueId, kind: "user", message, createdAt: new Date().toISOString() };
  },
  async closeSession(issueId: string) {
    this.closedSessions.push(issueId);
    await this.closeSessionHook?.(issueId);
  },
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
  engine.reservations.clear();
  engine.closeSessionHook = undefined;
  const app = await buildApi({ databaseFile: join(root, "issues.db"), stateRoot: root, engine: engine as never, modelCatalog, logger: false });
  let appClosed = false;
  try {
    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/internal/agent-capabilities/db", payload: {} })).statusCode, 404);
    const concurrentCurrentUsers = await Promise.all(Array.from({ length: 4 }, () => app.inject({ method: "GET", url: "/api/me" })));
    assert.deepEqual(concurrentCurrentUsers.map((response) => response.statusCode), [200, 200, 200, 200]);
    const currentSubject = (await json(concurrentCurrentUsers[0]!)).subject;
    assert.equal(currentSubject, issuePilotConfig.subject);
    const users = JSON.parse((await app.inject({ method: "GET", url: "/api/users" })).body) as Array<{ subject: string; name: string }>;
    assert.deepEqual(users.map((user) => user.subject), issuePilotConfig.users.map((user) => user.subject));
    const switchedUser = await app.inject({ method: "GET", url: "/api/me", headers: { "x-issue-pilot-subject": "hjx4403@xianhengguoji.com" } });
    assert.deepEqual(await json(switchedUser), { subject: "hjx4403@xianhengguoji.com", name: "黄佳鑫", email: "hjx4403@xianhengguoji.com" });
    const invalidUser = await app.inject({ method: "GET", url: "/api/me", headers: { "x-issue-pilot-subject": "missing-user" } });
    assert.equal(invalidUser.statusCode, 400);
    assert.equal((await json(invalidUser)).error, "invalid_current_subject");
    const people = JSON.parse((await app.inject({ method: "GET", url: "/api/people" })).body) as Array<{ subject: string }>;
    assert.ok(people.some((person) => person.subject === currentSubject));
    assert.ok(people.some((person) => person.subject === "hjx4403@xianhengguoji.com"));

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
      const repositories = service.repositoryUrls.map((url, index) => ({ alias: `${service.key}-${index + 1}`, url }));
      const response = await app.inject({
        method: "POST",
        url: "/api/services",
        payload: {
          name: service.name,
          description: `${service.name} service`,
          repositories,
          deployments: [
            { environmentKey: "test", repositoryBranches: repositories.map(({ alias }, index) => ({ repositoryAlias: alias, baseBranch: index === 0 ? "main" : "shared-main" })), capabilities: [], agent: { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "high" } },
            ...(service.key === "beta" ? [{ environmentKey: "dev", repositoryBranches: repositories.map(({ alias }) => ({ repositoryAlias: alias, baseBranch: "develop" })), capabilities: [], agent: { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "high" } }] : []),
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
      const response = await app.inject({ method: "POST", url: "/api/services", payload: { key, name: key, description: "", repositories: [{ alias: key, url: `https://example.test/${key}.git` }], deployments: [{ environmentKey: "test", repositoryBranches: [{ repositoryAlias: key, baseBranch: "main" }], capabilities: [], agent }] } });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal((await json(response)).error, expected);
    }

    const forgedCreateRepository = await app.inject({
      method: "POST",
      url: "/api/services",
      payload: { name: "Forged repository", repositories: [{ id: "foreign-id", alias: "forged", url: "https://example.test/forged.git" }], deployments: [] },
    });
    assert.equal(forgedCreateRepository.statusCode, 400, forgedCreateRepository.body);
    assert.equal((await json(forgedCreateRepository)).error, "invalid_repository");

    const shadowedConfiguration = openDatabase(join(root, "issues.db"));
    const [betaService] = await shadowedConfiguration.db.select({ id: services.id }).from(services).where(eq(services.key, "beta")).limit(1);
    const betaDeployments = await shadowedConfiguration.db.select().from(serviceDeployments).where(eq(serviceDeployments.serviceId, betaService!.id));
    for (const deployment of betaDeployments) {
      await shadowedConfiguration.db.update(serviceDeployments).set({ config: { ...deployment.config, environmentKey: "shadow", repositoryBranches: [] } }).where(eq(serviceDeployments.id, deployment.id));
    }
    await shadowedConfiguration.close();

    const modeled = await app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; repositories: Array<{ id: string; alias: string; url: string }>; deployments: Array<{ environmentKey: string; repositoryBranches: Array<{ repositoryId: string; repositoryAlias: string; baseBranch: string }>; agent: unknown }> }> };
    const alphaModel = modeled.services.find((service) => service.key === "alpha")!;
    const betaModel = modeled.services.find((service) => service.key === "beta")!;
    assert.deepEqual(betaModel.deployments.find((deployment) => deployment.environmentKey === "dev")?.repositoryBranches.map(({ repositoryAlias, baseBranch }) => ({ repositoryAlias, baseBranch })), [{ repositoryAlias: "beta-1", baseBranch: "develop" }]);
    assert.deepEqual(betaModel.deployments.map((deployment) => deployment.environmentKey), ["test", "dev"]);
    for (const field of ["id", "kind", "createdAt", "environmentIds"]) assert.equal(field in alphaModel, false);
    assert.equal(alphaModel.deployments.some((deployment) => "id" in deployment || "environmentId" in deployment), false);
    assert.equal(alphaModel.deployments[0]?.environmentKey, "test");
    assert.equal(alphaModel.repositories.some((repository) => "kind" in repository), false);
    assert.deepEqual(alphaModel.repositories.map(({ alias, url }) => ({ alias, url })), [
      { alias: "alpha-1", url: "https://example.test/alpha.git" },
      { alias: "alpha-2", url: "https://example.test/alpha-shared.git" },
    ]);
    assert.deepEqual(alphaModel.deployments[0]?.repositoryBranches.map(({ repositoryAlias, baseBranch }) => ({ repositoryAlias, baseBranch })), [
      { repositoryAlias: "alpha-1", baseBranch: "main" },
      { repositoryAlias: "alpha-2", baseBranch: "shared-main" },
    ]);
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
    engine.closeSessionHook = async () => { throw new Error("simulated_resolve_session_stop_failure"); };
    const failedResolve = await app.inject({ method: "PATCH", url: `/api/issues/${created.id}/status`, payload: { status: "resolved" } });
    assert.equal(failedResolve.statusCode, 500, failedResolve.body);
    assert.equal((await app.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((response) => JSON.parse(response.body)) as { status: string }).status, "pending");
    engine.closeSessionHook = undefined;
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
    const followUp = await app.inject({ method: "POST", url: `/api/issues/${created.id}/comments`, headers: { "x-issue-pilot-subject": "lyz5613@xianhengguoji.com" }, payload: { body: "A note for other users" } });
    assert.equal(followUp.statusCode, 201, followUp.body);
    const afterFollowUp = await app.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((response) => JSON.parse(response.body)) as { status: string; comments: Array<{ author: string; body: string }> };
    assert.equal(afterFollowUp.status, "open");
    assert.deepEqual(afterFollowUp.comments.map(({ author, body }) => ({ author, body })), [{ author: "刘宜展", body: "A note for other users" }]);
    assert.equal(engine.enqueued.length, enqueueCountBeforeComment);
    const agentMessage = await app.inject({ method: "POST", url: `/api/issues/${created.id}/agent-messages`, payload: { message: "Check the latest evidence" } });
    assert.equal(agentMessage.statusCode, 202, agentMessage.body);
    assert.equal(agentMessage.body, "");
    assert.equal(engine.messages.at(-1), "Check the latest evidence");
    assert.equal((await app.inject({ method: "POST", url: `/api/issues/${created.id}/agent-messages`, payload: { message: "" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: `/api/issues/${created.id}/agent-abort` })).statusCode, 404);

    const unmanagedNextIssueKey = String(created.id).replace(/001$/, "002");
    const unmanagedNextIssueRoot = join(root, "issues", unmanagedNextIssueKey.toLowerCase());
    await mkdir(unmanagedNextIssueRoot, { recursive: true });
    const unmanagedEvidence = join(unmanagedNextIssueRoot, "evidence.txt");
    await writeFile(unmanagedEvidence, "preserve unmanaged evidence\n", "utf8");
    const blockedByUnmanagedState = await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Must not claim unmanaged state", description: "", priority: "p2", type: "smart_analysis",
        environmentKey: "test", serviceKey: "alpha", assigneeSubject: null, ccSubjects: [],
      },
    });
    assert.equal(blockedByUnmanagedState.statusCode, 409, blockedByUnmanagedState.body);
    assert.equal((await json(blockedByUnmanagedState)).error, "unmanaged_issue_state");
    assert.equal(await readFile(unmanagedEvidence, "utf8"), "preserve unmanaged evidence\n");
    const unmanagedInspection = openDatabase(join(root, "issues.db"));
    assert.equal((await unmanagedInspection.db.select().from(issues)).length, 1);
    await unmanagedInspection.close();
    await rm(unmanagedNextIssueRoot, { recursive: true });

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
        repositories: [{ id: retainedRepository.id, alias: "alpha-api", url: retainedRepository.url }, { alias: "alpha-extra", url: "https://example.test/alpha-extra.git" }],
        deployments: [{ environmentKey: "test", repositoryBranches: [{ repositoryAlias: "alpha-api", baseBranch: "main" }, { repositoryAlias: "alpha-extra", baseBranch: "release" }], capabilities: ["playwright", "nacos", "db", "redis", "mq", "es", "sls"], agent: { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "high" }, nacos: { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["alpha-test.yaml"], username: "operator", password: "nacos-secret" }, db: { url: "mysql://db.example.test:3306/alpha", username: "readonly", password: "db-secret" }, redis: { host: "192.168.27.122", port: 6379, username: "", password: "redis-secret", database: 0 }, mq: { host: "192.168.27.122", port: 5672, managementPort: 15672, username: "admin", password: "mq-secret", virtualHost: "/" }, es: { url: "http://es-6.example.test", username: "", password: "" }, sls: { accessKeyId: "fixture-key", accessKeySecret: "sls-secret", region: "cn-test", project: "alpha-test", logstores: ["application"] }, playwright: { baseUrl: "https://alpha.example.test/admin/login", username: "operator", password: "deployment-secret" } }],
      },
    });
    assert.equal(repositoryUpdate.statusCode, 200, repositoryUpdate.body);
    assert.equal(engine.closedSessions.includes(createdInternalId), true);
    const afterRepositoryUpdate = await app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; name: string; deployments: Array<{ repositoryBranches: Array<{ repositoryId: string; repositoryAlias: string; baseBranch: string }>; capabilities: string[]; nacos: { dataIds: string[]; password: string }; db: { url: string; password: string }; sls: { accessKeySecret: string }; playwright: { baseUrl: string; username: string; password: string } | null }>; repositories: Array<{ id: string; alias: string; url: string }> }> };
    const updatedAlpha = afterRepositoryUpdate.services.find((service) => service.key === "alpha")!;
    assert.equal(updatedAlpha.name, "Alpha renamed");
    assert.equal(updatedAlpha.repositories.find((repository) => repository.url === retainedRepository.url)?.id, retainedRepository.id);
    assert.deepEqual(updatedAlpha.repositories.map(({ alias, url }) => ({ alias, url })), [{ alias: "alpha-api", url: "https://example.test/alpha.git" }, { alias: "alpha-extra", url: "https://example.test/alpha-extra.git" }]);
    assert.deepEqual(updatedAlpha.deployments.map((deployment) => ({ repositoryBranches: deployment.repositoryBranches.map(({ repositoryAlias, baseBranch }) => ({ repositoryAlias, baseBranch })), capabilities: deployment.capabilities, playwright: deployment.playwright })), [{ repositoryBranches: [{ repositoryAlias: "alpha-api", baseBranch: "main" }, { repositoryAlias: "alpha-extra", baseBranch: "release" }], capabilities: ["playwright", "nacos", "db", "redis", "mq", "es", "sls"], playwright: { baseUrl: "https://alpha.example.test/admin/login", username: "operator", password: "deployment-secret" } }]);
    assert.match(JSON.stringify(afterRepositoryUpdate), /deployment-secret/);
    assert.deepEqual(updatedAlpha.deployments[0]?.nacos.dataIds, ["alpha-test.yaml"]);
    assert.equal(updatedAlpha.deployments[0]?.nacos.password, "nacos-secret");
    assert.equal(updatedAlpha.deployments[0]?.db.url, "mysql://db.example.test:3306/alpha");
    assert.equal(updatedAlpha.deployments[0]?.db.password, "db-secret");
    assert.equal(updatedAlpha.deployments[0]?.sls.accessKeySecret, "sls-secret");

    const closedSessionsBeforeInvalidConfiguration = engine.closedSessions.length;
    const missingDbPassword = await app.inject({
      method: "PATCH",
      url: "/api/services/alpha",
      payload: { name: "Invalid DB", description: "", repositories: updatedAlpha.repositories, deployments: [{ environmentKey: "test", repositoryBranches: updatedAlpha.deployments[0]!.repositoryBranches, capabilities: ["db"], agent: { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "high" }, db: { url: "mysql://db.example.test:3306/alpha", username: "readonly", password: "" } }] },
    });
    assert.equal(missingDbPassword.statusCode, 400, missingDbPassword.body);
    assert.equal((await json(missingDbPassword)).error, "invalid_db_password");
    assert.equal(engine.closedSessions.length, closedSessionsBeforeInvalidConfiguration);
    const clearedOptionalCredentials = await app.inject({
      method: "PATCH",
      url: "/api/services/alpha",
      payload: {
        name: "Alpha renamed",
        description: "cleared optional credentials",
        repositories: updatedAlpha.repositories,
        deployments: [{
          environmentKey: "test", repositoryBranches: updatedAlpha.deployments[0]!.repositoryBranches, capabilities: ["playwright", "nacos", "es"],
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

    const gatedServicePayload = {
      name: "Alpha gated",
      description: "serialized with Agent sessions",
      repositories: updatedAlpha.repositories,
      deployments: [{
        environmentKey: "test",
        repositoryBranches: updatedAlpha.deployments[0]!.repositoryBranches,
        capabilities: [],
        agent: { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "high" },
      }],
    };
    let closeStarted!: () => void;
    let releaseClose!: () => void;
    const closeStartedPromise = new Promise<void>((resolve) => { closeStarted = resolve; });
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    let firstClose = true;
    engine.closeSessionHook = async () => {
      if (!firstClose) return;
      firstClose = false;
      closeStarted();
      await closeGate;
    };
    const gatedUpdate = app.inject({ method: "PATCH", url: "/api/services/alpha", payload: gatedServicePayload });
    await closeStartedPromise;
    const messageDuringUpdate = await app.inject({ method: "POST", url: `/api/issues/${created.id}/agent-messages`, payload: { message: "must wait for config" } });
    assert.equal(messageDuringUpdate.statusCode, 409, messageDuringUpdate.body);
    assert.equal((await json(messageDuringUpdate)).error, "issue_already_running");
    const configDuringUpdate = await app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; name: string }> };
    assert.equal(configDuringUpdate.services.find((service) => service.key === "alpha")!.name, "Alpha renamed");
    releaseClose();
    assert.equal((await gatedUpdate).statusCode, 200);
    engine.closeSessionHook = async () => { throw new Error("simulated_session_stop_failure"); };
    const failedStopUpdate = await app.inject({ method: "PATCH", url: "/api/services/alpha", payload: { ...gatedServicePayload, name: "Must not persist" } });
    assert.equal(failedStopUpdate.statusCode, 500, failedStopUpdate.body);
    const configAfterStopFailure = await app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; name: string }> };
    assert.equal(configAfterStopFailure.services.find((service) => service.key === "alpha")!.name, "Alpha gated");
    engine.closeSessionHook = undefined;

    const duplicateRepository = await app.inject({
      method: "PATCH",
      url: "/api/services/alpha",
      payload: { name: "Should roll back", description: "must not persist", repositories: [{ alias: "duplicate-1", url: "https://example.test/duplicate.git" }, { alias: "duplicate-2", url: "https://example.test/duplicate.git" }], deployments: [] },
    });
    assert.equal(duplicateRepository.statusCode, 400, duplicateRepository.body);
    assert.equal((await json(duplicateRepository)).error, "duplicate_repository");
    const duplicateAlias = await app.inject({
      method: "PATCH",
      url: "/api/services/alpha",
      payload: { name: "Should roll back", description: "must not persist", repositories: [{ alias: "duplicate", url: "https://example.test/one.git" }, { alias: "duplicate", url: "https://example.test/two.git" }], deployments: [] },
    });
    assert.equal(duplicateAlias.statusCode, 400, duplicateAlias.body);
    assert.equal((await json(duplicateAlias)).error, "duplicate_repository_alias");
    const missingDeploymentBranch = await app.inject({
      method: "PATCH",
      url: "/api/services/alpha",
      payload: { name: "Should roll back", description: "must not persist", repositories: updatedAlpha.repositories, deployments: [{ environmentKey: "test", repositoryBranches: [updatedAlpha.deployments[0]!.repositoryBranches[0]], capabilities: [], agent: { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "high" } }] },
    });
    assert.equal(missingDeploymentBranch.statusCode, 400, missingDeploymentBranch.body);
    assert.equal((await json(missingDeploymentBranch)).error, "invalid_deployment_repository_branches");
    const afterRejectedUpdate = await app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; name: string; repositories: Array<{ url: string }> }> };
    const preservedAlpha = afterRejectedUpdate.services.find((service) => service.key === "alpha")!;
    assert.equal(preservedAlpha.name, "Alpha gated");
    assert.deepEqual(preservedAlpha.repositories.map((repository) => repository.url).sort(), ["https://example.test/alpha-extra.git", "https://example.test/alpha.git"]);

    const usedDeploymentRemoval = await app.inject({
      method: "PATCH",
      url: "/api/services/alpha",
      payload: { name: "Must roll back", description: "deployment still in use", repositories: updatedAlpha.repositories, deployments: [] },
    });
    assert.equal(usedDeploymentRemoval.statusCode, 409, usedDeploymentRemoval.body);
    assert.equal((await json(usedDeploymentRemoval)).error, "deployment_is_used_by_issues");
    const afterDeploymentRollback = await app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; name: string; deployments: unknown[] }> };
    assert.equal(afterDeploymentRollback.services.find((service) => service.key === "alpha")?.name, "Alpha gated");
    assert.equal(afterDeploymentRollback.services.find((service) => service.key === "alpha")?.deployments.length, 1);

    const validUpdate = await app.inject({
      method: "PATCH",
      url: `/api/issues/${created.id}`,
      payload: { title: "Moved to beta", description: "", priority: "p2", type: "smart_analysis", serviceKey: "beta", assigneeSubject: null, ccSubjects: [] },
    });
    assert.equal(validUpdate.statusCode, 200, validUpdate.body);
    assert.equal(engine.enqueued.at(-1), createdInternalId);
    assert.equal(engine.recordedMessages.at(-1), false);
    assert.match(engine.messages.at(-1) ?? "", /\"key\": "beta"/);
    engine.running.delete(createdInternalId);
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
    const issueDirectoriesBeforeFailedCreate = await readdir(join(root, "issues")).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
      throw error;
    });
    const failingCreateDatabase = openDatabase(join(root, "issues.db"));
    const issueCountBeforeFailedCreate = Number((await failingCreateDatabase.client.execute("SELECT count(*) AS count FROM issues")).rows[0]!.count);
    await failingCreateDatabase.client.execute("CREATE TRIGGER fail_initial_attachment_insert BEFORE INSERT ON issue_attachments BEGIN SELECT RAISE(ABORT, 'simulated_initial_attachment_failure'); END");
    const failedCreateWithAttachment = await app.inject({
      method: "POST",
      url: "/api/issues",
      headers: { "content-type": `multipart/form-data; boundary=${createBoundary}` },
      payload: createWithAttachmentBody,
    });
    assert.equal(failedCreateWithAttachment.statusCode, 500, failedCreateWithAttachment.body);
    assert.equal((await json(failedCreateWithAttachment)).error, "internal_error");
    await failingCreateDatabase.client.execute("DROP TRIGGER fail_initial_attachment_insert");
    const issueCountAfterFailedCreate = Number((await failingCreateDatabase.client.execute("SELECT count(*) AS count FROM issues")).rows[0]!.count);
    await failingCreateDatabase.close();
    assert.equal(issueCountAfterFailedCreate, issueCountBeforeFailedCreate);
    assert.deepEqual((await readdir(join(root, "issues"))).sort(), issueDirectoriesBeforeFailedCreate.sort());
    assert.equal(engine.enqueued.length, enqueueCountBeforeMultipartCreate);

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
    const createdWithAttachmentFull = await app.inject({ method: "GET", url: `/api/issues/${issueWithAttachment.id}` }).then((response) => JSON.parse(response.body)) as { attachments: Array<{ id: string }> };
    const attachmentIssueInternalId = engine.enqueued.at(-1)!;
    engine.running.delete(attachmentIssueInternalId);
    const editBoundary = "issue-pilot-atomic-edit";
    const editIssue = {
      title: "Updated with replacement evidence", description: "Atomic edit", priority: "p2", type: "smart_analysis", serviceKey: "alpha", assigneeSubject: null, ccSubjects: [],
      removedAttachmentIds: [createdWithAttachmentFull.attachments[0]!.id],
    };
    const atomicEdit = await app.inject({
      method: "PATCH",
      url: `/api/issues/${issueWithAttachment.id}`,
      headers: { "content-type": `multipart/form-data; boundary=${editBoundary}`, "x-issue-pilot-subject": "lyz5613@xianhengguoji.com" },
      payload: Buffer.from([
        `--${editBoundary}`,
        'Content-Disposition: form-data; name="issue"',
        "",
        JSON.stringify(editIssue),
        `--${editBoundary}`,
        'Content-Disposition: form-data; name="files"; filename="replacement.txt"',
        "Content-Type: text/plain",
        "",
        "replacement evidence",
        `--${editBoundary}--`,
        "",
      ].join("\r\n")),
    });
    assert.equal(atomicEdit.statusCode, 200, atomicEdit.body);
    const afterAtomicEdit = await app.inject({ method: "GET", url: `/api/issues/${issueWithAttachment.id}` }).then((response) => JSON.parse(response.body)) as { title: string; attachments: Array<{ fileName: string }> };
    assert.equal(afterAtomicEdit.title, "Updated with replacement evidence");
    assert.deepEqual(afterAtomicEdit.attachments.map(({ fileName }) => fileName), ["replacement.txt"]);
    assert.match(engine.messages.at(-1) ?? "", /replacement\.txt/);
    assert.doesNotMatch(engine.messages.at(-1) ?? "", /initial\.txt/);
    engine.running.delete(attachmentIssueInternalId);

    const atomicDetail = await app.inject({ method: "GET", url: `/api/issues/${issueWithAttachment.id}` }).then((response) => JSON.parse(response.body)) as { attachments: Array<{ id: string }> };
    const failingEditDatabase = openDatabase(join(root, "issues.db"));
    await failingEditDatabase.client.execute("CREATE TRIGGER fail_atomic_attachment_insert BEFORE INSERT ON issue_attachments BEGIN SELECT RAISE(ABORT, 'simulated_atomic_edit_failure'); END");
    const failedEditBoundary = "issue-pilot-failed-atomic-edit";
    const failedAtomicEdit = await app.inject({
      method: "PATCH",
      url: `/api/issues/${issueWithAttachment.id}`,
      headers: { "content-type": `multipart/form-data; boundary=${failedEditBoundary}` },
      payload: Buffer.from([
        `--${failedEditBoundary}`,
        'Content-Disposition: form-data; name="issue"',
        "",
        JSON.stringify({ ...editIssue, title: "Must roll back", removedAttachmentIds: [atomicDetail.attachments[0]!.id] }),
        `--${failedEditBoundary}`,
        'Content-Disposition: form-data; name="files"; filename="must-not-persist.txt"',
        "Content-Type: text/plain",
        "",
        "failed replacement",
        `--${failedEditBoundary}--`,
        "",
      ].join("\r\n")),
    });
    assert.equal(failedAtomicEdit.statusCode, 500, failedAtomicEdit.body);
    await failingEditDatabase.client.execute("DROP TRIGGER fail_atomic_attachment_insert");
    await failingEditDatabase.close();
    const afterFailedAtomicEdit = await app.inject({ method: "GET", url: `/api/issues/${issueWithAttachment.id}` }).then((response) => JSON.parse(response.body)) as { title: string; attachments: Array<{ fileName: string }> };
    assert.equal(afterFailedAtomicEdit.title, "Updated with replacement evidence");
    assert.deepEqual(afterFailedAtomicEdit.attachments.map(({ fileName }) => fileName), ["replacement.txt"]);
    const restoredAttachmentDirectory = issueAttachmentRoot(root, String(issueWithAttachment.id));
    const restoredAttachmentFiles = await readdir(restoredAttachmentDirectory);
    assert.equal(restoredAttachmentFiles.length, 1);
    assert.equal(await readFile(join(restoredAttachmentDirectory, restoredAttachmentFiles[0]!), "utf8"), "replacement evidence");

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
    const attachmentDirectory = issueAttachmentRoot(root, String(created.id));
    const attachmentFiles = await readdir(attachmentDirectory);
    assert.equal(attachmentFiles.length, 1);
    assert.equal((await stat(join(attachmentDirectory, attachmentFiles[0]!))).mode & 0o777, 0o400);
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
    await chmod(attachmentPath, 0o600);
    await writeFile(attachmentPath, "diagnostic outpvt\n", "utf8");
    assert.equal((await app.inject({ method: "GET", url: `/api/issues/${created.id}/attachments/${uploaded[0]!.id}` })).statusCode, 500);
    await writeFile(attachmentPath, attachmentContent, "utf8");
    const syncResponse = await app.inject({ method: "POST", url: `/api/issues/${created.id}/sync` });
    assert.equal(syncResponse.statusCode, 202, syncResponse.body);
    assert.match(engine.messages.at(-1) ?? "", /Issue metadata was updated/);
    assert.match(engine.messages.at(-1) ?? "", /diagnostic\.txt/);
    assert.ok((engine.messages.at(-1) ?? "").includes(`/issues/${String(created.id).toLowerCase()}/attachments`));
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
        repositories: [{ id: "missing-repository", alias: "alpha", url: "https://example.test/alpha.git" }],
        deployments: [{ environmentKey: "test", repositoryBranches: [{ repositoryAlias: "alpha", baseBranch: "main" }], capabilities: [], agent: { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "high" } }],
      },
    });
    assert.equal(invalidServiceUpdate.statusCode, 400);
    assert.equal((await json(invalidServiceUpdate)).error, "invalid_repository");
    const crossServiceRepositoryUpdate = await app.inject({
      method: "PATCH",
      url: "/api/services/alpha",
      payload: {
        name: "Partially changed",
        description: "changed",
        repositories: [{ id: betaModel.repositories[0]!.id, alias: "alpha", url: "https://example.test/alpha.git" }],
        deployments: [{ environmentKey: "test", repositoryBranches: [{ repositoryAlias: "alpha", baseBranch: "main" }], capabilities: [], agent: { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "high" } }],
      },
    });
    assert.equal(crossServiceRepositoryUpdate.statusCode, 400);
    assert.equal((await json(crossServiceRepositoryUpdate)).error, "invalid_repository");
    const configuration = await app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; name: string }> };
    assert.equal(configuration.services.find((service) => service.key === "alpha")?.name, "Alpha gated");

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
