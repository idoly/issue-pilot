import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";

import { AgentEventBus } from "../../src/agent/events.ts";
import type { GitCommitIdentity } from "../../src/agent/pi-session.ts";
import { AGENT_THINKING_LEVELS, type EnvironmentKind } from "../../src/domain/contracts.ts";
import { buildApi } from "../../src/http/api.ts";

export const testAgent = { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "high" as const };

export const modelCatalog = {
  async list() {
    return [{ provider: "enterprise-ai", id: "engineering-model", contextWindow: 32_000, thinkingLevels: AGENT_THINKING_LEVELS.filter((level) => level === "medium" || level === "high") }];
  },
};

export class TestAgentController {
  readonly enqueued: string[] = [];
  readonly messages: Array<string | undefined> = [];
  readonly recordedMessages: boolean[] = [];
  readonly gitIdentities: Array<GitCommitIdentity | undefined> = [];
  readonly closedSessions: string[] = [];
  readonly running = new Set<string>();
  readonly reservations = new Set<string>();
  closeSessionHook: undefined | ((issueId: string) => Promise<void>);

  enqueue(issueId: string, message?: string, recordMessage = true): void {
    this.running.add(issueId);
    this.enqueued.push(issueId);
    this.messages.push(message);
    this.recordedMessages.push(recordMessage);
  }

  isRunning(issueId: string): boolean {
    return this.running.has(issueId);
  }

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
  }

  async send(issueId: string, message: string, gitIdentity?: GitCommitIdentity): Promise<void> {
    if (this.reservations.has(issueId)) throw new Error("issue_already_running");
    this.messages.push(message);
    this.gitIdentities.push(gitIdentity);
    this.enqueued.push(issueId);
  }

  async closeSession(issueId: string): Promise<void> {
    this.closedSessions.push(issueId);
    await this.closeSessionHook?.(issueId);
  }
}

export interface ApiFixture {
  root: string;
  databaseFile: string;
  app: FastifyInstance;
  engine: TestAgentController;
  stop(): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createApiFixture(options: { events?: AgentEventBus } = {}): Promise<ApiFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-api-"));
  const databaseFile = path.join(root, "issues.db");
  const engine = new TestAgentController();
  const app = await buildApi({ databaseFile, stateRoot: root, engine, ...(options.events ? { events: options.events } : {}), modelCatalog, logger: false });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await app.close();
  };
  return {
    root,
    databaseFile,
    app,
    engine,
    stop,
    async cleanup() {
      await stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function json(response: { body: string }): Promise<Record<string, unknown>> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

export function servicePayload(name: string, environments: EnvironmentKind[] = ["test"], repositoryUrls = [`https://example.test/${name.toLowerCase()}.git`]) {
  const key = name.toLowerCase();
  const repositories = repositoryUrls.map((url, index) => ({ alias: `${key}-${index + 1}`, url }));
  return {
    name,
    description: `${name} service`,
    repositories,
    deployments: environments.map((environmentKey) => ({
      environmentKey,
      repositoryBranches: repositories.map(({ alias }, index) => ({ repositoryAlias: alias, baseBranch: index === 0 ? (environmentKey === "dev" ? "develop" : "main") : "shared-main" })),
      capabilities: [],
      agent: testAgent,
    })),
  };
}

export async function createService(app: FastifyInstance, name: string, environments: EnvironmentKind[] = ["test"], repositoryUrls?: string[]) {
  const response = await app.inject({ method: "POST", url: "/api/services", payload: servicePayload(name, environments, repositoryUrls) });
  assert.equal(response.statusCode, 201, response.body);
  return json(response);
}

export function issuePayload(serviceKey: string, environmentKey: EnvironmentKind = "test", title = "Test issue") {
  return {
    title,
    description: "Investigate the issue",
    priority: "p1",
    type: environmentKey === "dev" ? "defect_fix" : "smart_analysis",
    environmentKey,
    serviceKey,
    assigneeSubject: null,
    ccSubjects: [],
  };
}

export async function createIssue(app: FastifyInstance, serviceKey: string, environmentKey: EnvironmentKind = "test", title = "Test issue") {
  const response = await app.inject({ method: "POST", url: "/api/issues", payload: issuePayload(serviceKey, environmentKey, title) });
  assert.equal(response.statusCode, 201, response.body);
  return json(response);
}
