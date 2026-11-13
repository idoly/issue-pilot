import { and, eq } from "drizzle-orm";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { arr, compile, lit, obj, oneOf, str, union, unknown as unknownSchema, type Static } from "@earendil-works/pi-schema";
import type { Database } from "../db/client.ts";
import { dingtalkMcpNames, loadMcpConnections, serviceMcpConnections } from "../configuration/service-mcp.ts";
import { publicMcpUrl } from "../configuration/mcp.ts";
import { deploymentContext } from "../configuration/service-context.ts";
import { issues, issueRepositories, issueServiceScopes, issueWorkspaces, repositories as repositoryCatalog } from "../db/schema.ts";
import { capabilityTextResult, structuredJsonResult } from "../capabilities/contracts.ts";
import { configuredCapabilities, type EnvironmentKind } from "../domain/contracts.ts";
import { issueCommandEnvironment, issueLocalCommands } from "./native-tools.ts";
import { objectToolParameters } from "./tool-schema.ts";
import { issueServiceIds, listEnvironmentServices, loadServiceRepositorySet } from "../workspace/issue-services.ts";
import { loadDeploymentRepositories } from "../workspace/deployment.ts";
import path from "node:path";
import { issueRepositoryWorkspaceNames, repositoryStorePath, type SharedCheckoutLease } from "../workspace/git.ts";
import type { IssueProjectManager } from "../workspace/project.ts";
import type { PersonalGitEnvironment } from "../workspace/git-credentials.ts";
import { resolveRecordedRepository } from "../workspace/runtime.ts";
import { readIssueBranchCommit } from "../workspace/issue-git.ts";
import { classifyRepositoryState } from "../workspace/state.ts";
import { executeLocalCommand } from "../process.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { prepareIssueCommand } from "./issue-sandbox.ts";

type Issue = typeof issues.$inferSelect;
const inputShapes = {
  list: obj({ operation: lit("list") }),
  describe: obj({ operation: lit("describe"), service: str(), environment: str() }),
  change: obj({ operation: oneOf(["include", "remove"]), service: str() }),
  index: obj({ operation: oneOf(["stage", "unstage"]), repository: str(), paths: arr(str(), { minItems: 1, maxItems: issuePilotConfig.limits.sourceBrowser.changeFiles }) }),
  commit: obj({ operation: lit("commit"), repository: str(), message: str({ minLength: 1, maxLength: 4000 }) }),
  push: obj({ operation: lit("push"), repository: str() }),
};
type WorkspaceInput = Static<(typeof inputShapes)[keyof typeof inputShapes]>;
type GitInput = Extract<WorkspaceInput, { repository: string }>;
type WorkspaceToolOptions = {
  stateRoot: string;
  runtimeRoot: string;
  personalGit?: PersonalGitEnvironment;
  commitEnvironment: Record<string, string>;
  networkDomains: readonly string[];
  checkoutLease?: SharedCheckoutLease;
  onScopeChanged?: (readRoots?: string[]) => void;
};

async function updateBoundBranch(database: Database, issue: Issue, input: GitInput, options: WorkspaceToolOptions, signal?: AbortSignal) {
  const rows = await database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
  if (classifyRepositoryState(rows) !== "development_workspace") throw new Error("workspace_git_read_only");
  const names = issueRepositoryWorkspaceNames(rows);
  const repository = rows.find((row) => names.get(row.url) === input.repository);
  if (!repository) throw new Error("workspace_repository_not_found");
  const { root, store } = await resolveRecordedRepository(options.stateRoot, issue.key, repository, input.repository, "development_workspace");
  if (!store || !repository.workingBranch) throw new Error("workspace_git_read_only");
  await readIssueBranchCommit(store, repository.workingBranch);
  const push = input.operation === "push";
  let args: string[];
  if ("paths" in input) {
    if (input.paths.some((value) => !value || value.includes("\0") || path.isAbsolute(value))) throw new Error("invalid_workspace_git_path");
    args = input.operation === "stage" ? ["add", "-A", "--", ...input.paths] : ["reset", "-q", "HEAD", "--", ...input.paths];
  } else if ("message" in input) {
    const message = input.message.trim();
    if (!message || message.includes("\0")) throw new Error("invalid_source_commit_message");
    args = ["commit", "-m", message];
  } else {
    if (!options.personalGit?.env.GIT_SSH_COMMAND || !/^(ssh:\/\/|[^/]+@[^:]+:)/.test(repository.url)) throw new Error("personal_git_ssh_credentials_required");
    const ref = `refs/heads/${repository.workingBranch}`;
    args = ["push", "--no-follow-tags", "--recurse-submodules=no", "--", "origin", `${ref}:${ref}`];
  }
  const prepared = await prepareIssueCommand(
    {
      writeRoot: options.runtimeRoot,
      stateRoot: options.stateRoot,
      writableGitStore: store,
      readRoots: [path.join(repositoryStorePath(options.stateRoot, repository.url), "objects"), ...(push ? (options.personalGit?.readRoots ?? []) : [])],
      networkDomains: options.networkDomains,
    },
    ["git", "-C", root, "--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-c", "maintenance.auto=false", "-c", "commit.gpgSign=false", ...args],
    root,
  );
  let failure: unknown;
  try {
    const { stdout, stderr, code, killed } = await executeLocalCommand(prepared.argv[0]!, prepared.argv.slice(1), {
      cwd: root,
      ...(signal ? { signal } : {}),
      timeout: issuePilotConfig.limits.process.gitOperationMs,
      maxOutputBytes: issuePilotConfig.limits.process.gitOutputBytes,
      environment: issueCommandEnvironment({
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        ...(push ? options.personalGit?.env : options.commitEnvironment),
      }),
    });
    signal?.throwIfAborted();
    if (killed) throw new Error("workspace_git_operation_timeout");
    if (code !== 0) throw new Error(`workspace_git_${input.operation}_failed: ${stderr.trim() || stdout.trim() || code}`);
    return structuredJsonResult(capabilityTextResult(JSON.stringify({ operation: input.operation, repository: input.repository, branch: repository.workingBranch }), { operation: input.operation }));
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await prepared.cleanup();
    } catch (error) {
      // biome-ignore lint/correctness/noUnsafeFinally: preserve the command error when cleanup also fails.
      throw new AggregateError(failure === undefined ? [error] : [failure, error], "workspace_git_cleanup_failed");
    }
  }
}

export async function createWorkspaceTool(database: Database, issue: Issue, environmentKind: EnvironmentKind, projects: IssueProjectManager, options: WorkspaceToolOptions) {
  const { runtimeRoot, personalGit, onScopeChanged } = options;
  const available = await listEnvironmentServices(database, issue.environmentId);
  // Development environments carry no investigation capability configuration of their own.
  const investigationCapabilities = (row: (typeof available)[number]) => configuredCapabilities(row.environment.kind === "dev" ? {} : row.deployment.config);
  const keys = available.filter((row) => row.environment.id === issue.environmentId).map((row) => row.service.key);
  const schema = objectToolParameters(
    structuredClone(
      union([
        inputShapes.list,
        ...available.map((row) => obj({ operation: lit("describe"), service: lit(row.service.key), environment: lit(row.environment.key) })),
        obj({ operation: oneOf(["include", "remove"]), service: oneOf(keys) }),
        ...(environmentKind === "dev" ? [inputShapes.index, inputShapes.commit, inputShapes.push] : []),
      ]),
    ),
  );
  const validateInput = compile(structuredClone(schema));
  return defineTool({
    name: "workspace",
    label: "Cross-service workspace",
    description:
      "List code services and investigation sources; describe an explicit source environment before service_query. include/remove manage repositories in this Issue's code environment. In development, stage/unstage take repository-relative paths, commit saves staged changes, and push sends only the bound branch to origin under the same name. Select the repository by its workspace directory name. Do not use bash to change Git metadata. No branch creation, switching, or target-branch publication.",
    parameters: schema,
    outputSchema: unknownSchema(),
    execute: async (_id, raw, signal) => {
      if (!validateInput.check(raw)) throw new Error("invalid_workspace_input");
      // Dynamic selector tuples lose static variants; derive the union from their shared shapes.
      const input = raw as WorkspaceInput;
      if (input.operation === "list") {
        const included = await issueServiceIds(database, issue);
        const names = new Map((await database.select().from(repositoryCatalog)).map((row) => [row.url, row.name]));
        // Load deployments concurrently; they are independent reads and a serial loop made the tool O(services) round trips.
        const services = await Promise.all(
          available.map(async (row) => {
            const deployment = await loadDeploymentRepositories(database, { serviceId: row.service.id, environmentId: row.environment.id });
            return {
              key: row.service.key,
              name: row.service.name,
              environment: row.environment.key,
              entry: row.service.id === issue.serviceId && row.environment.id === issue.environmentId,
              included: row.environment.id === issue.environmentId && included.includes(row.service.id),
              configuredCapabilities: investigationCapabilities(row),
              repositories: deployment.repositories.map(({ repository, baseBranch }) => ({ name: names.get(repository.url), baseBranch })),
            };
          }),
        );
        return structuredJsonResult(capabilityTextResult(JSON.stringify({ environment: environmentKind, services }), { operation: "list" }));
      }
      if (input.operation === "describe") {
        const target = available.find((row) => row.service.key === input.service && row.environment.key === input.environment);
        if (!target) throw new Error("service_not_available_in_environment");
        const mcpRows = (await loadMcpConnections(database)).map(({ id, name, url, transport, enabled, deploymentId }) => ({ id, name, url, transport, enabled, deploymentId }));
        const mcp = serviceMcpConnections(mcpRows, [target.deployment.id], await dingtalkMcpNames(database));
        const definition = await loadDeploymentRepositories(database, { serviceId: target.service.id, environmentId: target.environment.id });
        const names = new Map((await database.select().from(repositoryCatalog)).map((row) => [row.url, row.name]));
        const repositories = definition.repositories.map((row) => ({ name: names.get(row.repository.url) ?? row.repository.alias, url: row.repository.url, branch: row.baseBranch }));
        const context = deploymentContext(target.environment, target.deployment.config, mcp);
        return structuredJsonResult(
          capabilityTextResult(
            JSON.stringify({
              service: target.service.key,
              name: target.service.name,
              environment: target.environment.key,
              repositories,
              description: [target.service.description, context].filter(Boolean).join("\n\n"),
              capabilities: investigationCapabilities(target),
              mcp: mcp.filter((row) => row.enabled).map((row) => ({ ...row, url: publicMcpUrl(row.url) })),
            }),
            { operation: "describe" },
          ),
        );
      }
      return issueLocalCommands.run(runtimeRoot, async () => {
        signal?.throwIfAborted();
        const [current] = await database.select().from(issues).where(eq(issues.id, issue.id)).limit(1);
        if (!current || current.status === "resolved" || current.environmentId !== issue.environmentId || current.serviceId !== issue.serviceId) throw new Error("issue_scope_changed");
        if ("repository" in input) return updateBoundBranch(database, current, input, options, signal);
        const target = available.find((row) => row.service.key === input.service && row.environment.id === issue.environmentId);
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
          // Persist intent before cross-media preparation. A failed attempt retires the session too,
          // but only completed preparation grants the new paths to native tools in this round.
          let readRoots: string[] | undefined;
          try {
            const prepare = () => projects.prepare(current, environmentKind, personalGit?.env);
            const project = await (options.checkoutLease ? options.checkoutLease.run(prepare) : prepare());
            signal?.throwIfAborted();
            await database.update(issueWorkspaces).set({ runtimeReady: project.runtimeReady, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));
            readRoots = project.readRoots;
          } finally {
            onScopeChanged?.(readRoots);
          }
        }
        const rows = await database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
        const names = issueRepositoryWorkspaceNames(rows);
        return structuredJsonResult(
          capabilityTextResult(
            JSON.stringify({
              service: target.service.key,
              operation: input.operation,
              repositories: rows.map((row) => ({
                name: names.get(row.url),
                branch: row.workingBranch ?? row.baseBranch,
                baseCommit: row.commitBefore,
                path: row.localPath ?? path.join(runtimeRoot, names.get(row.url)!),
                writable: environmentKind === "dev",
              })),
            }),
            { operation: input.operation },
          ),
        );
      });
    },
  });
}
