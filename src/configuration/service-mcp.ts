import { dbHubConnections } from "./dbhub.ts";
import { mcpServices, serviceDeployments } from "../db/schema.ts";
import type { Database } from "../db/client.ts";

/** Service tools are enabled deployment-owned rows in scope; global rows (no deployment) serve application imports only. */
export function serviceMcpConnections<Row extends { enabled: boolean; deploymentId?: string | null }>(rows: readonly Row[], deploymentIds: readonly string[]): Row[] {
  const scope = new Set(deploymentIds);
  return rows.filter((row) => row.enabled && row.deploymentId != null && scope.has(row.deploymentId));
}

/** Read within the caller's configuration scope/snapshot. Generated connections are never persisted. */
export async function loadMcpConnections(database: Pick<Database, "select">) {
  const [connections, deployments] = await Promise.all([database.select().from(mcpServices), database.select().from(serviceDeployments)]);
  return [...connections, ...dbHubConnections(deployments, connections)];
}
