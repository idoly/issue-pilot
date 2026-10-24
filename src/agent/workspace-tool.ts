import { and, eq } from "drizzle-orm";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import type { Database } from "../db/client.ts";
import { publicMcpUrl } from "../configuration/mcp.ts";
import { deploymentContext } from "../configuration/service-context.ts";
import { resolveDeploymentConfiguration } from "../configuration/credentials.ts";
import { issues, issueRepositories, issueServiceScopes, issueWorkspaces, mcpServices, repositories as repositoryCatalog } from "../db/schema.ts";
import { capabilityTextResult, structuredJsonResult } from "../capabilities/contracts.ts";
import { configuredCapabilities, type EnvironmentKind } from "../domain/contracts.ts";
import { issueLocalCommands } from "./native-tools.ts";
import { issueServiceIds, listEnvironmentServices, loadServiceRepositorySet } from "../workspace/issue-services.ts";
import { loadDeploymentRepositories } from "../workspace/deployment.ts";
import path from "node:path";
import { issueRepositoryWorkspaceNames } from "../workspace/git.ts";
import type { IssueProjectManager } from "../workspace/project.ts";

type Issue = typeof issues.$inferSelect;
const inputShapes = {
  list: Type.Object({ operation: Type.Literal("list") }, { additionalProperties: false }),
  describe: Type.Object({ operation: Type.Literal("describe"), service: Type.String(), environment: Type.String() }, { additionalProperties: false }),
  change: Type.Object({ operation: Type.Union([Type.Literal("include"), Type.Literal("remove")]), service: Type.String() }, { additionalProperties: false }),
};
type WorkspaceInput = Static<(typeof inputShapes)[keyof typeof inputShapes]>;

export async function createWorkspaceTool(database: Database, issue: Issue, environmentKind: EnvironmentKind, projects: IssueProjectManager, runtimeRoot: string, gitEnvironment?: Record<string, string>) {
  const available = await listEnvironmentServices(database, issue.environmentId);
  const keys = available.filter(row => row.environment.id === issue.environmentId).map(row => row.service.key);
  const schema = Value.Clone(Type.Union([
    inputShapes.list,
    ...available.map(row => Type.Object({ ...inputShapes.describe.properties, service: Type.Literal(row.service.key), environment: Type.Literal(row.environment.key) }, { additionalProperties: false })),
    Type.Object({ ...inputShapes.change.properties, service: Type.Union(keys.map((key) => Type.Literal(key))) }, { additionalProperties: false }),
  ]));
  const validateInput = Compile(schema);
  return defineTool({ name: "workspace", label: "Cross-service workspace", description: "List code services and permitted investigation sources; development Issues can describe production/test services. Describe with an explicit source environment before service_query. include/remove manage repositories only in this Issue's code environment; investigations get read-only snapshots. Existing Issue branches are preserved. remove can detach an additional service only when its repositories are safe to remove.", parameters: schema, outputSchema: Type.Unknown(),
    execute: async (_id, raw, signal) => {
      if (!validateInput.Check(raw)) throw new Error("invalid_workspace_input");
      // Dynamic selector tuples lose static variants; derive the union from their shared shapes.
      const input = raw as WorkspaceInput;
      if (input.operation === "list") {
        const included = await issueServiceIds(database, issue);
        const names = new Map((await database.select().from(repositoryCatalog)).map((row) => [row.url, row.name]));
        const services = [];
        for (const row of available) {
          const deployment = await loadDeploymentRepositories(database, { serviceId: row.service.id, environmentId: row.environment.id });
          services.push({ key: row.service.key, name: row.service.name, environment: row.environment.key, entry: row.service.id === issue.serviceId && row.environment.id === issue.environmentId, included: row.environment.id === issue.environmentId && included.includes(row.service.id), configuredCapabilities: configuredCapabilities(row.environment.kind === "dev" ? {} : row.deployment.config), repositories: deployment.repositories.map(({ repository, baseBranch }) => ({ name: names.get(repository.url), baseBranch })) });
        }
        return structuredJsonResult(capabilityTextResult(JSON.stringify({ environment: environmentKind, services }), { operation: "list" }));
      }
      if (input.operation === "describe") {
        const target = available.find(row => row.service.key === input.service && row.environment.key === input.environment);
        if (!target) throw new Error("service_not_available_in_environment");
        const mcp = await database.select({ id: mcpServices.id, name: mcpServices.name, url: mcpServices.url, transport: mcpServices.transport, enabled: mcpServices.enabled }).from(mcpServices);
        const definition = await loadDeploymentRepositories(database, { serviceId: target.service.id, environmentId: target.environment.id });
        const names = new Map((await database.select().from(repositoryCatalog)).map(row => [row.url, row.name]));
        const repositories = definition.repositories.map(row => ({ name: names.get(row.repository.url) ?? row.repository.alias, url: row.repository.url, branch: row.baseBranch }));
        const context = deploymentContext(target.environment, target.deployment.config, mcp);
        return structuredJsonResult(capabilityTextResult(JSON.stringify({ service: target.service.key, name: target.service.name, environment: target.environment.key, repositories, description: [target.service.description, context].filter(Boolean).join("\n\n"), capabilities: configuredCapabilities(target.environment.kind === "dev" ? {} : resolveDeploymentConfiguration(target.deployment.config)), mcp: mcp.filter(row => row.enabled).map(row => ({ ...row, url: publicMcpUrl(row.url) })) }), { operation: "describe" }));
      }
      return issueLocalCommands.run(runtimeRoot, async () => {
        signal?.throwIfAborted();
        const [current] = await database.select().from(issues).where(eq(issues.id, issue.id)).limit(1);
        if (!current || current.status === "resolved" || current.environmentId !== issue.environmentId || current.serviceId !== issue.serviceId) throw new Error("issue_scope_changed");
        const target = available.find((row) => row.service.key === input.service && row.environment.id === issue.environmentId)!;
        if (!target) throw new Error("service_not_available_in_environment");
        if (input.operation === "remove" && target.service.id === issue.serviceId) throw new Error("entry_service_cannot_be_removed");
        const included = await issueServiceIds(database, issue);
        const [workspace] = await database.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue.id)).limit(1);
        const already = included.includes(target.service.id);
        if (!(already && input.operation === "include" && workspace?.runtimeReady) && !(input.operation === "remove" && !already)) {
          const next = input.operation === "include" ? [...new Set([...included, target.service.id])] : included.filter((id) => id !== target.service.id);
          await loadServiceRepositorySet(database, next, issue.environmentId);
          await database.transaction(async (tx) => {
            if (input.operation === "include") await tx.insert(issueServiceScopes).values({ issueId: issue.id, serviceId: target.service.id }).onConflictDoNothing();
            else await tx.delete(issueServiceScopes).where(and(eq(issueServiceScopes.issueId, issue.id), eq(issueServiceScopes.serviceId, target.service.id)));
            await tx.update(issueWorkspaces).set({ runtimeReady: false, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));
          });
          // Persist intent before cross-media preparation. On failure, keep refs,
          // rows and files so a repeat include/remove or the next round can retry.
          const project = await projects.prepare(current, environmentKind, gitEnvironment);
          signal?.throwIfAborted();
          await database.update(issueWorkspaces).set({ runtimeReady: project.runtimeReady, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));
        }
        const rows = await database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
        const names = issueRepositoryWorkspaceNames(rows);
        return structuredJsonResult(capabilityTextResult(JSON.stringify({ service: target.service.key, operation: input.operation, repositories: rows.map((row) => ({ name: names.get(row.url), branch: row.workingBranch ?? row.baseBranch, path: row.localPath ?? path.join(runtimeRoot, names.get(row.url)!), writable: environmentKind === "dev" })) }), { operation: input.operation }));
      });
    },
  });
}
