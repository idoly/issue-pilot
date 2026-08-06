import { stat } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";

import { openDatabase } from "../db/client.ts";
import { serviceDeployments } from "../db/schema.ts";
import type { IssuePolicy } from "../pi/policy.ts";

export async function deploymentConfig(policy: IssuePolicy, deploymentId: string): Promise<Record<string, unknown>> {
  const stateRoot = process.env.ISSUE_PILOT_STATE_ROOT ?? path.dirname(path.dirname(policy.workspaceRoot));
  const databaseFile = path.resolve(process.env.ISSUE_PILOT_DATABASE ?? path.join(stateRoot, "issues.db"));
  const metadata = await stat(databaseFile);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error("insecure_issue_database_file");
  const database = openDatabase(databaseFile);
  try {
    const [deployment] = await database.db.select({ config: serviceDeployments.config }).from(serviceDeployments).where(eq(serviceDeployments.id, deploymentId)).limit(1);
    if (!deployment) throw new Error("capability_deployment_not_found");
    return deployment.config;
  } finally {
    await database.close();
  }
}

export async function deploymentCapabilityConfig(policy: IssuePolicy, deploymentId: string, key: "nacos" | "db" | "sls" | "playwright" | "redis" | "es" | "mq"): Promise<Record<string, unknown>> {
  const value = (await deploymentConfig(policy, deploymentId))[key];
  if (!value || typeof value !== "object") throw new Error("capability_configuration_not_found");
  return value as Record<string, unknown>;
}
