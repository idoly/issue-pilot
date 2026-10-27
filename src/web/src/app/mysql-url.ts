import type { MysqlTarget } from "../../../domain/contracts";

export function mysqlTargetUrl(target: MysqlTarget): string {
  const host = target.host.includes(":") && !target.host.startsWith("[") ? `[${target.host}]` : target.host;
  return `mysql://${encodeURIComponent(target.username)}:${encodeURIComponent(target.password)}@${host}:${target.port}/${encodeURIComponent(target.database)}`;
}

export function mysqlTargetFromUrl(value: string): MysqlTarget {
  try {
    const url = new URL(value.trim());
    const username = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (url.protocol !== "mysql:" || !url.hostname || !username.trim() || !password || !database.trim() || url.search || url.hash || url.pathname.slice(1).includes("/") || [username, password, database].some(part => part.includes("\0"))) throw new Error();
    const port = url.port ? Number(url.port) : 3306;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    return { host: url.hostname, port, username, password, database };
  } catch {
    throw new Error("invalid_mysql_url");
  }
}
