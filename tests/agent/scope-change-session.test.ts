import assert from "node:assert/strict";
import { createBareRemote, git } from "../helpers/git.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { claimIssueRoot } from "../../src/workspace/state.ts";
import { AgentEngine } from "../../src/agent/engine.ts";
import type { StartPiSessionOptions } from "../../src/agent/pi-session.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import {
  environments,
  globalAgentConfiguration,
  issues,
  issueServiceScopes,
  issueWorkspaces,
  mcpServices,
  serviceDeploymentRepositories,
  serviceDeployments,
  serviceRepositories,
  services,
  subjects,
  userCredentials,
} from "../../src/db/schema.ts";
import { registerTestRepositories } from "../helpers/repositories.ts";

test("a workspace scope change retires the live session so removed service MCP tools are not reused", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-scope-session-"));
  const stateRoot = path.join(root, "state");
  const database = await openApplicationDatabase(path.join(stateRoot, "issues.db"));
  try {
    const { source, remote: ordersRemote } = await createBareRemote(root, { branch: "develop", remote: "orders.git" });
    const remotes = [ordersRemote, path.join(root, "billing.git")];
    await git(["clone", "--bare", source, remotes[1]!]);
    await database.db.insert(globalAgentConfiguration).values({ id: 1, provider: "test-provider", model: "test-model", thinkingLevel: "medium" });
    await database.db.insert(subjects).values({ subject: "tester", displayName: "Tester", role: "developer" });
    await database.db
      .insert(userCredentials)
      .values({ subject: "tester", modelCredentials: { provider: "test-provider", model: "test-model", thinkingLevel: "medium", codemode: "on", apiKey: "fixture-key" } });
    const environmentRows = await database.db.select().from(environments);
    const dev = environmentRows.find((environment) => environment.kind === "dev")!;
    const prod = environmentRows.find((environment) => environment.kind === "prod")!;
    await registerTestRepositories(database.db, remotes);
    const created = [];
    for (const [index, key] of ["orders", "billing"].entries()) {
      const [service] = await database.db.insert(services).values({ key, name: key }).returning();
      const [repository] = await database.db.insert(serviceRepositories).values({ serviceId: service!.id, alias: key, url: remotes[index]! }).returning();
      const [devDeployment] = await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: dev.id, config: {} }).returning();
      const [prodDeployment] = await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: prod.id, config: {} }).returning();
      await database.db.insert(serviceDeploymentRepositories).values({ deploymentId: prodDeployment!.id, repositoryId: repository!.id, baseBranch: "develop" });
      await database.db.insert(mcpServices).values({ name: `${key} tools`, url: `https://${key}.example.test/mcp`, transport: "streamable_http", enabled: true, deploymentId: devDeployment!.id });
      created.push(service!);
    }
    const [orders, billing] = created as [(typeof created)[number], (typeof created)[number]];
    const [issue] = await database.db
      .insert(issues)
      .values({ key: "ISSUE-20261103-001", title: "Scope change", type: "defect_fix", serviceId: orders.id, environmentId: dev.id, reporterSubject: "tester" })
      .returning();
    await claimIssueRoot(stateRoot, issue!.key);
    await database.db.insert(issueWorkspaces).values({ issueId: issue!.id });
    await database.db.insert(issueServiceScopes).values({ issueId: issue!.id, serviceId: billing.id });

    const starts: string[][] = [];
    let stops = 0;
    const engine = new AgentEngine(database.db, stateRoot);
    const internal = engine as unknown as {
      piRuntime: { start(options: Pick<StartPiSessionOptions, "mcpConfigurations" | "workspaceTool">): Promise<unknown>; close(): Promise<void> };
      run(issueId: string): Promise<void>;
      sessions: Map<string, unknown>;
    };
    internal.piRuntime = {
      async start(options) {
        const round = starts.push((options.mcpConfigurations ?? []).map((row) => row.name).sort());
        return {
          session: {},
          streaming: false,
          async prompt() {
            if (round === 1) await options.workspaceTool!.execute("remove", { operation: "remove", service: "billing" }, undefined, undefined, undefined as never);
          },
          async stop() {
            stops += 1;
          },
        };
      },
      async close() {},
    };

    await internal.run(issue!.id);
    assert.deepEqual(starts[0], ["billing tools", "orders tools"]);
    assert.deepEqual(
      (await database.db.select().from(issueServiceScopes).where(eq(issueServiceScopes.issueId, issue!.id))).map((row) => row.serviceId),
      [],
    );
    assert.equal(stops, 1);
    assert.equal(internal.sessions.has(issue!.id), false);

    await internal.run(issue!.id);
    assert.deepEqual(starts[1], ["orders tools"]);
    // Without a scope change the writable development session stays live for the next round.
    assert.equal(stops, 1);
    assert.equal(internal.sessions.has(issue!.id), true);
    await engine.close();
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
