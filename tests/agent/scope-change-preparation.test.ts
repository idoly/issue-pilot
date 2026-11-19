// A related-Issue scope change signalled while this Issue's round is preparing (no live session yet) must
// still retire the session that preparation creates, instead of reusing roots captured before the change.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const { createBareRemote } = await import("../helpers/git.ts");
const { registerTestRepositories } = await import("../helpers/repositories.ts");
const { claimIssueRoot } = await import("../../src/workspace/state.ts");
const { AgentEngine } = await import("../../src/agent/engine.ts");
const { openApplicationDatabase } = await import("../../src/db/bootstrap.ts");
const schema = await import("../../src/db/schema.ts");

test("scope change signalled during preparation is applied to the session that preparation creates", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ip-repro-scope-"));
  const stateRoot = path.join(root, "state");
  const database = await openApplicationDatabase(path.join(stateRoot, "issues.db"));
  let engine: InstanceType<typeof AgentEngine> | undefined;
  try {
    const { remote } = await createBareRemote(root, { branch: "develop", remote: "orders.git" });
    await database.db.insert(schema.globalAgentConfiguration).values({ id: 1, provider: "test-provider", model: "test-model", thinkingLevel: "medium" });
    await database.db.insert(schema.subjects).values({ subject: "tester", displayName: "Tester", role: "developer" });
    await database.db
      .insert(schema.userCredentials)
      .values({ subject: "tester", modelCredentials: { provider: "test-provider", model: "test-model", thinkingLevel: "medium", codemode: "on", apiKey: "fixture-key" } });
    const environmentRows = await database.db.select().from(schema.environments);
    const dev = environmentRows.find((environment: { kind: string }) => environment.kind === "dev")!;
    const prod = environmentRows.find((environment: { kind: string }) => environment.kind === "prod")!;
    await registerTestRepositories(database.db, [remote]);
    const [service] = await database.db.insert(schema.services).values({ key: "orders", name: "orders" }).returning();
    const [repository] = await database.db.insert(schema.serviceRepositories).values({ serviceId: service!.id, alias: "orders", url: remote }).returning();
    await database.db.insert(schema.serviceDeployments).values({ serviceId: service!.id, environmentId: dev.id, config: {} });
    const [prodDeployment] = await database.db.insert(schema.serviceDeployments).values({ serviceId: service!.id, environmentId: prod.id, config: {} }).returning();
    await database.db.insert(schema.serviceDeploymentRepositories).values({ deploymentId: prodDeployment!.id, repositoryId: repository!.id, baseBranch: "develop" });
    const [issue] = await database.db
      .insert(schema.issues)
      .values({ key: "ISSUE-20261119-001", title: "Reader", type: "defect_fix", serviceId: service!.id, environmentId: dev.id, reporterSubject: "tester" })
      .returning();
    await claimIssueRoot(stateRoot, issue!.key);
    await database.db.insert(schema.issueWorkspaces).values({ issueId: issue!.id });

    engine = new AgentEngine(database.db, stateRoot);
    const live = engine;
    const internal = engine as unknown as {
      piRuntime: { start(): Promise<unknown>; close(): Promise<void> };
      run(issueId: string): Promise<void>;
      isReusableSession(issueId: string, managed: unknown): boolean;
      sessions: Map<string, unknown>;
    };
    internal.piRuntime = {
      async start() {
        // Preparation has already read the related views. A related Issue is now released/reopened/converted;
        // lifecycle calls markScopeChanged for its readers while this reader has no registered session yet.
        live.markScopeChanged([issue!.id]);
        return { session: {}, streaming: false, async prompt() {}, async stop() {} };
      },
      async close() {},
    };
    await internal.run(issue!.id);
    // The round itself completes, then retires the session it prepared: the next message re-prepares.
    assert.equal(internal.sessions.has(issue!.id), false, "the session prepared before the change is retired");
  } finally {
    await engine?.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
