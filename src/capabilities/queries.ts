import type { CommandExecutor } from "./local-exec.ts";

import { readNacosConfigurations, type NacosConnection } from "./configuration.ts";
import type { IssuePolicy } from "../pi/policy.ts";
import { capabilityResultText } from "./limits.ts";
import { queryMysql, validateReadOnlyQuery } from "./mysql.ts";

export async function readConfiguration(pi: CommandExecutor, serviceKey: string, nacos: NacosConnection, signal?: AbortSignal) {
  const text = capabilityResultText({ configurations: await readNacosConfigurations(pi, nacos, signal) });
  return {
    content: [{ type: "text" as const, text }],
    details: { serviceKey },
  };
}

export async function readDatabase(policy: IssuePolicy, config: Record<string, unknown>, input: { statement: string }, signal?: AbortSignal) {
  const statement = validateReadOnlyQuery(input.statement);
  const scope = policy.service.db;
  if (!scope) throw new Error("db_scope_not_granted_for_service");
  if (typeof config.url !== "string" || typeof config.username !== "string" || typeof config.password !== "string") throw new Error("db_configuration_not_found");
  const connection = new URL(config.url);
  connection.username = config.username;
  connection.password = config.password;
  const output = await queryMysql({ connectionUrl: connection.href, statement }, signal);
  const text = capabilityResultText({ provider: "mysql", ...output });
  return {
    content: [{ type: "text" as const, text }],
    details: { serviceKey: policy.service.serviceKey, deploymentId: scope.deploymentId },
  };
}
