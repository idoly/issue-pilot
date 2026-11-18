import path from "node:path";
import { chmod } from "node:fs/promises";
import { eq } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import type { issues } from "../db/schema.ts";
import { issueAttachments } from "../db/schema.ts";
import type { AgentConfiguration, DeploymentConfig, EnvironmentKind, IssueType } from "../domain/contracts.ts";
import { isDevelopmentEnvironment, personGitIdentity } from "../domain/contracts.ts";
import type { McpConfiguration } from "../mcp/client.ts";
import type { AgentSessionContext } from "./context.ts";
import { createAgentSessionContext } from "./context.ts";
import { gitIdentityEnvironment, type GitCommitIdentity } from "./pi-session.ts";
import type { PersonalGitEnvironment } from "../workspace/git-credentials.ts";
import { createWorkspaceTool } from "./workspace-tool.ts";
import type { ServiceToolScope } from "./service-query-tool.ts";
import { loadEnabledCapabilities } from "../configuration/capability-switches.ts";
import { loadMcpConnections, serviceMcpConnections } from "../configuration/service-mcp.ts";
import type { loadIssueCredentialOwner } from "../configuration/user-credentials.ts";
import { loadSharedCapabilityCredentials, resolveIssueCapabilities } from "../configuration/user-credentials.ts";
import { projectCapabilityConfiguration } from "../configuration/credentials.ts";
import type { ResolvedAgentModel } from "../configuration/agent.ts";
import { issueServiceIds, listEnvironmentServices } from "../workspace/issue-services.ts";
import type { IssueProjectManager, PreparedIssueProject } from "../workspace/project.ts";
import type { SharedCheckoutLease } from "../workspace/git.ts";
import { assertIssueRoot } from "../workspace/state.ts";
import { openVerifiedAttachmentFile } from "../workspace/attachments.ts";

type IssueRow = typeof issues.$inferSelect;

export interface PrepareAgentRoundInput {
  database: Database;
  stateRoot: string;
  projectManager: IssueProjectManager;
  issue: IssueRow;
  service: {
    id: string;
    key: string;
    name: string;
    description: string | null;
    environmentKey: string;
    environmentKind: EnvironmentKind;
  };
  environmentKind: EnvironmentKind;
  owner: Awaited<ReturnType<typeof loadIssueCredentialOwner>>;
  model: ResolvedAgentModel;
  gitIdentity: GitCommitIdentity;
  personalGit?: PersonalGitEnvironment;
  checkoutLease: SharedCheckoutLease;
  /** The round's abort signal; throws when the round is already cancelled. */
  signal: () => AbortSignal | undefined;
  /** Called after the workspace tool changes this round's read roots. */
  onScopeChanged: (roots: string[] | undefined) => void;
}

export interface PreparedAgentRound {
  project: PreparedIssueProject;
  sharedRepositories: boolean;
  workDirectory: string;
  attachmentPath: string;
  agentConfiguration: AgentConfiguration;
  context: AgentSessionContext;
  deploymentConfig: DeploymentConfig;
  serviceScopes: ServiceToolScope[];
  mcpConfigurations: McpConfiguration[];
  workspaceTool: Awaited<ReturnType<typeof createWorkspaceTool>>;
  commitIdentity: GitCommitIdentity;
  readRoots: () => string[];
}

/** Everything a round needs before the session starts: workspace, evidence, credentials, tools and prompt context. */
export async function prepareAgentRound(input: PrepareAgentRoundInput): Promise<PreparedAgentRound> {
  const { database, issue, owner, model, personalGit, checkoutLease } = input;
  const agentConfiguration = model.configuration;
  const workDirectory = await assertIssueRoot(input.stateRoot, issue.key);
  input.signal();
  const project = await checkoutLease.run(() => input.projectManager.prepare(issue, input.environmentKind, personalGit?.env, input.signal()));
  input.signal();
  const sharedRepositories = project.repositories.every((repository) => repository.access === "read");
  await chmod(workDirectory, 0o700);
  const attachmentPath = workDirectory;
  await chmod(path.dirname(workDirectory), 0o700);
  const attachments = await database.select().from(issueAttachments).where(eq(issueAttachments.issueId, issue.id));
  for (const attachment of attachments) {
    const handle = await openVerifiedAttachmentFile(attachmentPath, attachment.objectKey, attachment.size, attachment.sha256, input.signal());
    await handle.close();
  }
  const environmentServices = await listEnvironmentServices(database, issue.environmentId);
  const queryServices = environmentServices.filter((row) => !isDevelopmentEnvironment(row.environment.kind));
  const shared = await loadSharedCapabilityCredentials(database);
  const serviceScopes: ServiceToolScope[] = queryServices.map((row) => {
    const config = projectCapabilityConfiguration(row.deployment.config);
    const scope = { environmentKey: row.environment.key, serviceKey: row.service.key, serviceName: row.service.name };
    // Each capability resolves independently so a missing DMS group does not block SLS, and vice versa.
    // Failed targets stay discoverable; the selected query reports its own credential error at execution time.
    const { configuration: resolved, errors: credentialErrors } = resolveIssueCapabilities(config, owner.credentials, shared);
    return { ...scope, config: resolved, credentialErrors };
  });
  const deploymentConfig = serviceScopes.find((scope) => scope.serviceKey === input.service.key && scope.environmentKey === input.service.environmentKey)?.config ?? {};
  const mcpRows = await loadMcpConnections(database);
  const includedServiceIds = new Set(await issueServiceIds(database, issue));
  const mcpConfigurations: McpConfiguration[] = serviceMcpConnections(
    mcpRows,
    environmentServices.filter((row) => includedServiceIds.has(row.service.id)).map((row) => row.deployment.id),
  );
  const context = createAgentSessionContext({
    issueKey: issue.key,
    issueType: issue.type as IssueType,
    enabledCapabilities: await loadEnabledCapabilities(database),
    deploymentConfig,
    additionalDeploymentConfigs: serviceScopes.map((scope) => scope.config),
    agentConfiguration,
    serviceKey: input.service.key,
    environmentKey: input.service.environmentKey,
    environmentKind: input.environmentKind,
    repositoryAccess: project.repositories.map((repository) => repository.access),
  });
  let readRoots = project.readRoots;
  const commitIdentity = owner.user.role === "developer" ? personGitIdentity(owner.user) : input.gitIdentity;
  const workspaceTool = await createWorkspaceTool(database, issue, input.environmentKind, input.projectManager, {
    stateRoot: input.stateRoot,
    runtimeRoot: project.runtimeRoot,
    ...(personalGit ? { personalGit } : {}),
    commitEnvironment: gitIdentityEnvironment(commitIdentity),
    networkDomains: agentConfiguration.runtime.networkAllowedDomains ?? [],
    checkoutLease,
    onScopeChanged: (updatedRoots) => {
      if (updatedRoots) readRoots = updatedRoots;
      input.onScopeChanged(updatedRoots);
    },
  });
  return {
    project,
    sharedRepositories,
    workDirectory,
    attachmentPath,
    agentConfiguration,
    context,
    deploymentConfig,
    serviceScopes,
    mcpConfigurations,
    workspaceTool,
    commitIdentity,
    readRoots: () => readRoots,
  };
}
