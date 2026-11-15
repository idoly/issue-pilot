import assert from "node:assert/strict";
import { createBareRemote } from "../helpers/git.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { AgentEngine } from "../../src/agent/engine.ts";
import type { StartPiSessionOptions } from "../../src/agent/pi-session.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import {
  applicationSettings,
  environments,
  globalAgentConfiguration,
  issues,
  issueWorkspaces,
  serviceDeploymentRepositories,
  serviceDeployments,
  serviceRepositories,
  services,
  subjects,
  userCredentials,
} from "../../src/db/schema.ts";
import { claimIssueRoot } from "../../src/workspace/state.ts";
import { registerTestRepositories } from "../helpers/repositories.ts";

test("a missing DMS credential group does not discard the SLS credentials of the same deployment", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-credential-scopes-"));
  const stateRoot = path.join(root, "state");
  const database = await openApplicationDatabase(path.join(stateRoot, "issues.db"));
  try {
    const { remote } = await createBareRemote(root, { remote: "orders.git" });
    await database.db.insert(globalAgentConfiguration).values({ id: 1, provider: "test-provider", model: "test-model", thinkingLevel: "medium", apiKey: "shared-key" });
    // Shared SLS only; neither a shared nor a personal DMS group exists.
    await database.db
      .insert(applicationSettings)
      .values({ id: 1, maxConcurrentIssues: 4, sharedSlsCredentials: { accessKeyId: "shared-sls-id", accessKeySecret: "shared-sls-secret" } })
      .onConflictDoUpdate({ target: applicationSettings.id, set: { sharedSlsCredentials: { accessKeyId: "shared-sls-id", accessKeySecret: "shared-sls-secret" } } });
    await database.db.insert(subjects).values({ subject: "tester", displayName: "Tester", role: "product" });
    await database.db.insert(userCredentials).values({ subject: "tester" });
    const [prod] = await database.db.select().from(environments).where(eq(environments.kind, "prod"));
    await registerTestRepositories(database.db, [remote]);
    const [service] = await database.db.insert(services).values({ key: "orders", name: "Orders" }).returning();
    const [repository] = await database.db.insert(serviceRepositories).values({ serviceId: service!.id, alias: "orders", url: remote }).returning();
    const [deployment] = await database.db
      .insert(serviceDeployments)
      .values({
        serviceId: service!.id,
        environmentId: prod!.id,
        config: {
          dms: { databases: [{ instanceAlias: "ORDERS", schemaName: "orders", instanceId: "1", instanceHost: "db.example.test", instancePort: "3306", databaseId: "2" }] },
          sls: { region: "cn-test", project: "orders", logstores: ["application"] },
        },
      })
      .returning();
    await database.db.insert(serviceDeploymentRepositories).values({ deploymentId: deployment!.id, repositoryId: repository!.id, baseBranch: "main" });
    const [issue] = await database.db
      .insert(issues)
      .values({ key: "ISSUE-20261103-201", title: "Credentials", type: "smart_analysis", serviceId: service!.id, environmentId: prod!.id, reporterSubject: "tester" })
      .returning();
    await claimIssueRoot(stateRoot, issue!.key);
    await database.db.insert(issueWorkspaces).values({ issueId: issue!.id });

    const starts: Array<Pick<StartPiSessionOptions, "serviceScopes">> = [];
    const engine = new AgentEngine(database.db, stateRoot);
    const internal = engine as unknown as {
      piRuntime: { start(options: Pick<StartPiSessionOptions, "serviceScopes">): Promise<unknown>; close(): Promise<void> };
      run(issueId: string): Promise<void>;
    };
    internal.piRuntime = {
      async start(options) {
        starts.push(options);
        return { session: {}, streaming: false, async prompt() {}, async stop() {} };
      },
      async close() {},
    };
    await internal.run(issue!.id);
    const scope = starts[0]!.serviceScopes!.find((row) => row.serviceKey === "orders" && row.environmentKey === prod!.key)!;
    assert.deepEqual(scope.credentialErrors, { dms: "dms_credentials_not_configured" });
    assert.equal(scope.config.sls?.accessKeyId, "shared-sls-id");
    assert.equal(scope.config.sls?.accessKeySecret, "shared-sls-secret");
    assert.equal(scope.config.dms?.authorization, undefined);
    await engine.close();
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
