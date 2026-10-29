import type { MysqlTarget } from "../domain/contracts.ts";
import { ApiError, record, text } from "../http/input.ts";

export function parseMysqlTargets(value: unknown): MysqlTarget[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ApiError(400, "invalid_mysql_targets");
  return value.map(raw => {
    const input = record(raw);
    const host = text(input.host, "mysql_host", 255);
    const port = input.port ?? 3306;
    if (/\s|[/\\\0]/.test(host) || !Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) throw new ApiError(400, "invalid_mysql_target");
    const password = input.password;
    if (typeof password !== "string" || !password.length || password.includes("\0")) throw new ApiError(400, "invalid_mysql_password");
    return { host, port: Number(port), username: text(input.username, "mysql_username", 255), password, database: text(input.database, "mysql_database", 255) };
  });
}
