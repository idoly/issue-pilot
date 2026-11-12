import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { mcpServices, serviceDeployments } from "../db/schema.ts";
import { DBHUB_DATABASES, type DbHubTarget } from "../domain/contracts.ts";
import { ApiError, choice, record, text } from "../http/input.ts";

export function parseDbHubTargets(value: unknown): DbHubTarget[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ApiError(400, "invalid_dbhub_targets");
  const seen = new Set<string>();
  return value.map((raw) => {
    const input = record(raw);
    const type = choice(
      input.type,
      "dbhub_type",
      DBHUB_DATABASES.map((database) => database.value),
    );
    const host = text(input.host, "dbhub_host", 255);
    const port = input.port ?? DBHUB_DATABASES.find((database) => database.value === type)!.port;
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
/** Deployment targets are authoritative; MCP launch configuration is a read projection. */
export function dbHubConnections(deployments: readonly (typeof serviceDeployments.$inferSelect)[], explicit: readonly { id: string; name: string }[] = []): (typeof mcpServices.$inferSelect)[] {
  const connections = deployments.flatMap((deployment) =>
    (deployment.config.dbhub ?? []).map((target) => {
      const identity = createHash("sha256")
        .update(JSON.stringify([deployment.id, target.type, target.host, target.port, target.database]))
        .digest("hex")
        .slice(0, 24);
      return {
        id: `dbhub-${identity}`,
        name: `DBHub-${target.type}-${identity}`,
        url: "",
        authorization: "",
        transport: "stdio" as const,
        enabled: true,
        deploymentId: deployment.id,
        createdAt: deployment.createdAt,
        updatedAt: deployment.updatedAt,
        stdio: {
          command: process.execPath,
          args: [createRequire(import.meta.url).resolve("@bytebase/dbhub"), "--transport", "stdio", "--config", fileURLToPath(new URL("../../scripts/dbhub.toml", import.meta.url))],
          env: { DBHUB_DSN: dbHubDsn(target) },
        },
      };
    }),
  );
  const ids = new Set(explicit.map((row) => row.id));
  const names = new Set(explicit.map((row) => row.name));
  for (const row of connections) {
    if (ids.has(row.id) || names.has(row.name)) throw new ApiError(409, "mcp_name_conflict");
    ids.add(row.id);
    names.add(row.name);
  }
  return connections;
}
