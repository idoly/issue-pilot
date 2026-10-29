import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { mcpServices } from "../db/schema.ts";
import { DBHUB_DATABASES, type DbHubTarget, type StoredDeploymentConfig } from "../domain/contracts.ts";
import { ApiError, choice, record, text } from "../http/input.ts";

type Writer = Pick<Database, "select" | "insert" | "update" | "delete">;
export function deploymentDbHubTargets(config: Pick<StoredDeploymentConfig, "dbhub" | "mysql">): DbHubTarget[] {
  return config.dbhub ?? (config.mysql ?? []).map(target => ({ ...target, type: "mysql" }));
}
export function parseDbHubTargets(value: unknown): DbHubTarget[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ApiError(400, "invalid_dbhub_targets");
  const seen = new Set<string>();
  return value.map(raw => {
    const input = record(raw);
    const type = choice(input.type, "dbhub_type", DBHUB_DATABASES.map(database => database.value));
    const host = text(input.host, "dbhub_host", 255);
    const port = input.port ?? DBHUB_DATABASES.find(database => database.value === type)!.port;
    if (/\s|[/\\\0@?#]/.test(host) || !Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) throw new ApiError(400, "invalid_dbhub_target");
    if (typeof input.password !== "string" || !input.password.length || input.password.includes("\0")) throw new ApiError(400, "invalid_dbhub_password");
    const target = { type, host, port: Number(port), username: text(input.username, "dbhub_username", 255), password: input.password, database: text(input.database, "dbhub_database", 255) };
    const identity = JSON.stringify([type, host, port, target.database]);
    if (seen.has(identity)) throw new ApiError(400, "duplicate_dbhub_target");
    seen.add(identity);
    return target;
  });
}
export function dbHubDsn(target: DbHubTarget): string {
  const host = target.host.includes(":") && !target.host.startsWith("[") ? `[${target.host}]` : target.host;
  return `${target.type}://${encodeURIComponent(target.username)}:${encodeURIComponent(target.password)}@${host}:${target.port}/${encodeURIComponent(target.database)}`;
}
export async function saveDbHubConnections(writer: Writer, deploymentId: string, targets: DbHubTarget[]): Promise<void> {
  const previous = await writer.select().from(mcpServices).where(eq(mcpServices.deploymentId, deploymentId));
  const retained = new Set<string>();
  for (const target of targets) {
    const identity = createHash("sha256").update(JSON.stringify([deploymentId, target.type, target.host, target.port, target.database])).digest("hex").slice(0, 24);
    const id = `dbhub-${identity}`;
    if (retained.has(id)) throw new ApiError(400, "duplicate_dbhub_target");
    retained.add(id);
    const values = { name: `DBHub-${target.type}-${identity}`, url: "", authorization: "", transport: "stdio" as const, enabled: true, deploymentId,
      stdio: { command: process.execPath, args: [createRequire(import.meta.url).resolve("@bytebase/dbhub"), "--transport", "stdio", "--config", fileURLToPath(new URL("../../scripts/dbhub.toml", import.meta.url))], env: { DBHUB_DSN: dbHubDsn(target) } } };
    const old = previous.find(row => row.id === id);
    if (!old || Object.entries(values).some(([key, value]) => JSON.stringify(old[key as keyof typeof old]) !== JSON.stringify(value))) {
      await writer.insert(mcpServices).values({ id, ...values }).onConflictDoUpdate({ target: mcpServices.id, set: { ...values, updatedAt: new Date() } });
    }
  }
  for (const row of previous) if (!retained.has(row.id)) await writer.delete(mcpServices).where(eq(mcpServices.id, row.id));
}
