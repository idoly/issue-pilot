import { dbHubConnections } from "./dbhub.ts";
import { mcpServices, serviceDeployments, userPreferences } from "../db/schema.ts";
import type { Database } from "../db/client.ts";

/** DingTalk connections are application import resources, never service tools. */
export async function dingtalkMcpNames(database: Pick<Database, "select">): Promise<Set<string>> {
  const preferences = await database.select({ dingtalk: userPreferences.dingtalk }).from(userPreferences);
  return new Set(["dingtalk", ...preferences.flatMap((row) => (row.dingtalk.source?.mcp ? [row.dingtalk.source.mcp] : []))]);
}

export function serviceMcpConnections<Row extends { name: string; enabled: boolean; deploymentId?: string | null }>(
  rows: readonly Row[],
  deploymentIds: readonly string[],
  importNames: ReadonlySet<string>,
): Row[] {
  const scope = new Set(deploymentIds);
  return rows.filter((row) => row.enabled && row.deploymentId != null && scope.has(row.deploymentId) && !importNames.has(row.name));
}

/** Read within the caller's configuration scope/snapshot. Generated connections are never persisted. */
export async function loadMcpConnections(database: Pick<Database, "select">) {
  const [connections, deployments] = await Promise.all([database.select().from(mcpServices), database.select().from(serviceDeployments)]);
  return [...connections, ...dbHubConnections(deployments, connections)];
}
