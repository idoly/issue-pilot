import { registerTestRepositories } from "../helpers/repositories.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";

import { claimIssueRoot } from "../../src/workspace/state.ts";
import { AgentEngine } from "../../src/agent/engine.ts";
import type { StartPiSessionOptions } from "../../src/agent/pi-session.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import {
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

const git = (args: string[]) => promisify(execFile)("git", args);

test("owners with a personal model group use it entirely; everyone else uses the shared model and key", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-model-key-"));
  const stateRoot = path.join(root, "state");
  const database = await openApplicationDatabase(path.join(stateRoot, "issues.db"));
  try {
    await database.db.insert(globalAgentConfiguration).values({ id: 1, provider: "test-provider", model: "test-model", thinkingLevel: "medium" });
    const [production] = await database.db.select().from(environments).where(eq(environments.kind, "prod")).limit(1);
    const [service] = await database.db.insert(services).values({ key: "keys", name: "Keys" }).returning();
    const source = path.join(root, "source"),
      remote = path.join(root, "remote.git");
    await git(["init", "-b", "prod", source]);
    await writeFile(path.join(source, "README.md"), "baseline\n");
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "initial"]);
    await git(["clone", "--bare", source, remote]);
    await registerTestRepositories(database.db, [remote]);
    const [repository] = await database.db.insert(serviceRepositories).values({ serviceId: service!.id, alias: "keys", url: remote }).returning();
    const [deployment] = await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: production!.id, config: {} }).returning();
    await database.db.insert(serviceDeploymentRepositories).values({ deploymentId: deployment!.id, repositoryId: repository!.id, baseBranch: "prod" });
    await database.db.insert(subjects).values([
      { subject: "product", displayName: "Product", role: "product" },
      { subject: "developer", displayName: "Developer", role: "developer" },
    ]);
    const personal = { provider: "personal-provider", model: "personal-model", thinkingLevel: "high" as const, codemode: "only" as const, apiKey: "personal-key" };
    await database.db.insert(userCredentials).values({ subject: "product", modelApiKeys: { "test-provider": "retired-key" } });
    const [issue] = await database.db
      .insert(issues)
      .values({ key: "ISSUE-20261102-001", title: "Keys", type: "defect_fix", serviceId: service!.id, environmentId: production!.id, reporterSubject: "product" })
      .returning();
    await claimIssueRoot(stateRoot, issue!.key);
    await database.db.insert(issueWorkspaces).values({ issueId: issue!.id });

    const engine = new AgentEngine(database.db, stateRoot);
    const keys: Array<string | undefined> = [],
      models: string[] = [];
    const internal = engine as unknown as { piRuntime: { start(options: StartPiSessionOptions): Promise<unknown>; close(): Promise<void> }; run(issueId: string): Promise<void> };
    internal.piRuntime = {
      async start(options) {
        keys.push(options.modelApiKey);
        models.push(`${options.context.model.provider}/${options.context.model.modelId}/${options.context.model.thinkingLevel}/${options.context.codemode}`);
        return { session: {}, streaming: false, async prompt() {}, async stop() {} };
      },
      async close() {},
    };

    await assert.rejects(internal.run(issue!.id), /model_api_key_not_configured/);
    await database.db.update(globalAgentConfiguration).set({ apiKey: "shared-key" });
    // Retired per-provider keys are history and do not form a personal group, for any role.
    await internal.run(issue!.id);
    await database.db.update(issues).set({ assigneeSubject: "developer" }).where(eq(issues.id, issue!.id));
    await internal.run(issue!.id);
    await database.db.insert(userCredentials).values({ subject: "developer", modelApiKeys: { "test-provider": "retired-key" } });
    await internal.run(issue!.id);
    await database.db.update(userCredentials).set({ modelCredentials: personal }).where(eq(userCredentials.subject, "developer"));
    await internal.run(issue!.id);
    // Personal groups apply to every role, not only developers.
    await database.db
      .update(userCredentials)
      .set({ modelCredentials: { ...personal, apiKey: "product-key" } })
      .where(eq(userCredentials.subject, "product"));
    await database.db.update(issues).set({ assigneeSubject: null }).where(eq(issues.id, issue!.id));
    await internal.run(issue!.id);
    assert.deepEqual(keys, ["shared-key", "shared-key", "shared-key", "personal-key", "product-key"]);
    const shared = "test-provider/test-model/medium/on",
      own = "personal-provider/personal-model/high/only";
    assert.deepEqual(models, [shared, shared, shared, own, own]);
    await engine.close();
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
