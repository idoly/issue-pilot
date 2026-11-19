import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { mcpServices, serviceDeployments } from "../db/schema.ts";
import { DBHUB_DATABASES, type DbHubTarget } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import { choice, record, text } from "../domain/input.ts";

/**
 * Targets identify a database by type, host, port, database and username. An omitted (empty) password keeps
 * the stored value for the same identity, so editing another field never sends the secret to the browser;
 * a changed identity requires the password again.
 */
export function parseDbHubTargets(value: unknown, existing: readonly DbHubTarget[] = []): DbHubTarget[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new DomainError("invalid_dbhub_targets", "bad_request");
  const identity = (target: Pick<DbHubTarget, "type" | "host" | "port" | "database" | "username">) => JSON.stringify([target.type, target.host, target.port, target.database, target.username]);
  const retained = new Map(existing.map((target) => [identity(target), target.password]));
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
    if (/\s|[/\\\0@?#]/.test(host) || !Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) throw new DomainError("invalid_dbhub_target", "bad_request");
    if (input.password !== undefined && (typeof input.password !== "string" || input.password.includes("\0"))) throw new DomainError("invalid_dbhub_password", "bad_request");
    const username = text(input.username, "dbhub_username", 255);
    const database = text(input.database, "dbhub_database", 255);
    const target = { type, host, port: Number(port), username, database, password: "" };
    const password = typeof input.password === "string" && input.password.length ? input.password : retained.get(identity(target));
    if (!password) throw new DomainError("invalid_dbhub_password", "bad_request");
    const duplicate = JSON.stringify([type, host, port, database]);
    if (seen.has(duplicate)) throw new DomainError("duplicate_dbhub_target", "bad_request");
    seen.add(duplicate);
    return { ...target, password };
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
    if (ids.has(row.id) || names.has(row.name)) throw new DomainError("mcp_name_conflict", "conflict");
    ids.add(row.id);
    names.add(row.name);
  }
  return connections;
}
