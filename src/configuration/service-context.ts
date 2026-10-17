import { type DeploymentConfig, type StoredDeploymentConfig } from "../domain/contracts.ts";
import { projectDeploymentConfiguration } from "./credentials.ts";

type Field = readonly [string, string | number | readonly string[] | undefined];

function code(value: string | number): string {
  const escaped = String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("|", "&#124;").replace(/\r?\n/g, " ");
  return `<code>${escaped}</code>`;
}

function section(title: string, fields: readonly Field[]): string {
  const rows = fields.filter(([, value]) => value !== undefined && value !== "" && (!Array.isArray(value) || value.length))
    .map(([label, value]) => `| ${label} | ${Array.isArray(value) ? value.map(code).join("<br>") : code(value as string | number)} |`);
  return [`#### ${title}`, "", "| | |","| --- | --- |", ...rows].join("\n");
}

/** Render public configuration once for both the UI and model context. */
export function deploymentContext(environment: { key: string; name: string }, configuration: StoredDeploymentConfig, mcp: readonly { id: string; name: string; url: string; transport: string; enabled: boolean }[], credentials?: DeploymentConfig, mcpCredentials: readonly { id: string; authorization: string }[] = []): string {
  const sections = [`### ${environment.name}环境`];
  if (environment.key === "dev") return [...sections, "仅配置代码分支；查询能力继承正式和测试环境，来源保持只读。"].join("\n\n");
  const value = projectDeploymentConfiguration(configuration);
  const authentication = (configured: boolean, secret?: string): Field[] => secret ? [["密码", secret]] : [["认证", configured ? "已配置" : "无需认证"]];
  if (value.nacos) {
    const v = value.nacos;
    sections.push(section("Nacos", [["地址", v.serverUrl], ["Namespace", v.namespace || "默认"], ["Group", v.group], ["Data ID", v.dataIds], ["用户", v.username], ...authentication(v.credentialConfigured, credentials?.nacos?.password)]));
  }
  if (value.db) value.db.databases.forEach((database, index) => sections.push(section(value.db!.databases.length > 1 ? `MySQL · 数据库 ${index + 1}` : "MySQL", [["地址", database.url], ["用户", database.username], ...authentication(database.credentialConfigured, credentials?.db?.databases.find(row => row.url === database.url)?.password)])));
  if (value.redis) {
    const v = value.redis;
    sections.push(section("Redis", [["地址", `${v.host}:${v.port}`], ["Database", v.database], ["用户", v.username], ...authentication(v.credentialConfigured, credentials?.redis?.password)]));
  }
  if (value.mq) {
    const v = value.mq;
    sections.push(section("RabbitMQ", [["管理地址", `${v.host}:${v.managementPort}`], ["Virtual host", v.virtualHost], ["用户", v.username], ...authentication(v.credentialConfigured, credentials?.mq?.password)]));
  }
  if (value.es) {
    const v = value.es;
    sections.push(section("Elasticsearch", [["地址", v.url], ["用户", v.username], ...authentication(v.credentialConfigured, credentials?.es?.password)]));
  }
  if (value.dms) value.dms.databases.forEach((database, index) => sections.push(section(value.dms!.databases.length > 1 ? `DMS · 数据库 ${index + 1}` : "DMS", [["实例", database.instanceAlias], ["Schema", database.schemaName], ["地址", `${database.instanceHost}:${database.instancePort}`], ["InstanceId", database.instanceId], ["DatabaseId", database.databaseId]])));
  if (value.sls) {
    const v = value.sls;
    sections.push(section("SLS", [["Region", v.region], ["Project", v.project], ["Logstore", v.logstores]]));
  }
  for (const row of mcp.filter(row => value.mcpServices?.includes(row.id))) sections.push(section("MCP", [["名称", row.name], ["地址", row.url], ["协议", row.transport === "streamable_http" ? "Streamable HTTP" : "SSE"], ["状态", row.enabled ? "开启" : "关闭"], ["Authorization", mcpCredentials.find(secret => secret.id === row.id)?.authorization]]));
  if (sections.length === 1) sections.push("未配置外部查询能力。");
  return sections.join("\n\n");
}
