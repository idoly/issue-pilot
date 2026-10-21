import { type DeploymentConfig, type StoredDeploymentConfig } from "../domain/contracts.ts";
import { publicMcpUrl } from "./mcp.ts";
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
export function deploymentContext(environment: { key: string; name: string }, configuration: StoredDeploymentConfig, mcp: readonly { id: string; name: string; url: string; transport: string; enabled: boolean }[], _credentials?: DeploymentConfig, mcpCredentials: readonly { id: string; authorization: string }[] = []): string {
  const sections = [`### ${environment.name}环境`];
  if (environment.key === "dev") return [...sections, "仅配置代码分支；查询能力继承正式和测试环境，来源保持只读。"].join("\n\n");
  const value = projectDeploymentConfiguration(configuration);
  if (value.dms) value.dms.databases.forEach((database, index) => sections.push(section(value.dms!.databases.length > 1 ? `DMS · 数据库 ${index + 1}` : "DMS", [["实例", database.instanceAlias], ["Schema", database.schemaName], ["地址", `${database.instanceHost}:${database.instancePort}`], ["InstanceId", database.instanceId], ["DatabaseId", database.databaseId]])));
  if (value.sls) {
    const v = value.sls;
    if (v.targets) for (const target of v.targets) sections.push(section(`SLS · ${target.name}`, [["Region", target.region], ["Project", target.project], ["Logstore", target.logstores]]));
    else sections.push(section("SLS", [["Region", v.region], ["Project", v.project], ["Logstore", v.logstores]]));
  }
  for (const row of mcp.filter(row => row.enabled)) sections.push(section("MCP（全局）", [["名称", row.name], ["地址", publicMcpUrl(row.url)], ["协议", row.transport === "stdio" ? "stdio（本地进程）" : row.transport === "streamable_http" ? "Streamable HTTP" : "SSE"], ["状态", row.enabled ? "开启" : "关闭"], ["Authorization", mcpCredentials.find(secret => secret.id === row.id)?.authorization]]));
  if (sections.length === 1) sections.push("未配置外部查询能力。");
  return sections.join("\n\n");
}
