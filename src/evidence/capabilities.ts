import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { resolveConfigurations, type NacosConnection } from "./configuration.ts";
import type { GrantedRepository, IssuePolicy } from "../pi/policy.ts";
import { queryMysql, validateReadOnlyQuery } from "./mysql.ts";

export async function readConfiguration(pi: ExtensionAPI, repositories: GrantedRepository[], controlledConfiguration: Record<string, unknown>, signal?: AbortSignal, nacos?: NacosConnection) {
  const resolvedRepositories = [];
  for (const repository of repositories) {
    resolvedRepositories.push({
      repository: path.basename(repository.repositoryPath),
      configurations: await resolveConfigurations(pi, repository, signal, {}, nacos),
    });
  }
  const result = { controlledConfiguration, repositories: resolvedRepositories };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    details: { serviceKey: repositories[0]!.serviceKey, controlledConfiguration },
  };
}

export async function readDatabase(pi: ExtensionAPI, policy: IssuePolicy, config: Record<string, unknown>, cwd: string, input: { statement: string }, signal?: AbortSignal) {
  const statement = validateReadOnlyQuery(input.statement);
  const scope = policy.service.db;
  if (!scope) throw new Error("db_scope_not_granted_for_service");
  if (typeof config.url !== "string" || typeof config.username !== "string" || typeof config.password !== "string") throw new Error("db_configuration_not_found");
  const connection = new URL(config.url);
  connection.username = config.username;
  connection.password = config.password;
  const output = await queryMysql(pi, cwd, { connectionUrl: connection.href, statement }, signal);
  const connectionConfiguration = { url: config.url, username: config.username, password: config.password };
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ provider: "mysql", connection: connectionConfiguration, ...output }, null, 2) }],
    details: { serviceKey: policy.service.serviceKey, deploymentId: scope.deploymentId, connection: connectionConfiguration },
  };
}
