import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { applicationSettings, mcpServices } from "../db/schema.ts";
import type { MysqlTarget } from "../domain/contracts.ts";
import { ApiError, record, text } from "../http/input.ts";

type Writer = Pick<Database, "select" | "insert" | "update" | "delete">;

export function parseMysqlTargets(value: unknown): MysqlTarget[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ApiError(400, "invalid_mysql_targets");
  return value.map(raw => {
    const input = record(raw);
    const host = text(input.host, "mysql_host", 255);
    const port = input.port ?? 3306;
    if (/\s|[/\\\0]/.test(host) || !Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) throw new ApiError(400, "invalid_mysql_target");
    return { host, port: Number(port), username: text(input.username, "mysql_username", 255),
      password: typeof input.password === "string" && input.password.length && !input.password.includes("\0") ? input.password : (() => { throw new ApiError(400, "invalid_mysql_password"); })(),
      database: text(input.database, "mysql_database", 255),
    };
  });
}

/** Generated MySQL MCP entries belong to their deployment, with literal private environment credentials. */
export async function saveMysqlConnections(writer: Writer, deploymentId: string, targets: MysqlTarget[]): Promise<void> {
  const [settings] = await writer.select().from(applicationSettings).limit(1);
  const template = settings?.mysqlStdio ?? { command: "npx", args: ["-y", "@benborla29/mcp-server-mysql@2.0.9"], env: {} };
  const previous = await writer.select().from(mcpServices).where(eq(mcpServices.deploymentId, deploymentId));
  const retained = new Set<string>();
  for (const target of targets) {
    const identity = createHash("sha256").update(JSON.stringify([deploymentId, target.host, target.port, target.database])).digest("hex").slice(0, 24);
    const id = `mysql-${identity}`;
    if (retained.has(id)) throw new ApiError(400, "duplicate_mysql_target");
    retained.add(id);
    const values = { name: `mysql-${target.database.slice(0, 40)}-${identity}`, url: "", authorization: "", transport: "stdio" as const, enabled: true, deploymentId,
      stdio: { ...template, env: { ...template.env, MYSQL_HOST: target.host, MYSQL_PORT: String(target.port), MYSQL_USER: target.username, MYSQL_PASS: target.password, MYSQL_DB: target.database,
        ALLOW_INSERT_OPERATION: "false", ALLOW_UPDATE_OPERATION: "false", ALLOW_DELETE_OPERATION: "false" } } };
    const old = previous.find(row => row.id === id);
    if (!old || Object.entries(values).some(([key, value]) => JSON.stringify(old[key as keyof typeof old]) !== JSON.stringify(value))) {
      await writer.insert(mcpServices).values({ id, ...values }).onConflictDoUpdate({ target: mcpServices.id, set: { ...values, updatedAt: new Date() } });
    }
  }
  for (const row of previous) if (!retained.has(row.id)) await writer.delete(mcpServices).where(eq(mcpServices.id, row.id));
}
