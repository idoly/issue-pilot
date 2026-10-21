import { DatabaseSync } from "node:sqlite";
import { mkdir, lstat, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseDocument, stringify } from "yaml";
import { applicationConfig } from "../src/config.ts";

const { values } = parseArgs({ options: { "state-root": { type: "string" }, output: { type: "string" }, subject: { type: "string" }, "reference-service": { type: "string" }, "reference-mcp": { type: "string" } } });
if (!values.output || !values.subject) throw new Error("usage: prepare-configuration.ts --output STAGING_DIRECTORY --subject SUBJECT [--state-root ROOT] [--reference-service FILE] [--reference-mcp FILE]");
const root = path.resolve(values["state-root"] ?? applicationConfig.stateRoot), output = path.resolve(values.output);
if (root === output) throw new Error("configuration_output_must_be_staging");
const database = new DatabaseSync(path.join(root, applicationConfig.state.databaseFile), { readOnly: true });
const created: string[] = [];
database.exec("BEGIN");
try {
  const owner = database.prepare("SELECT * FROM subjects WHERE subject=? AND active=1").get(values.subject);
  if (!owner) throw new Error("configuration_user_not_active");
  const credentials = database.prepare("SELECT * FROM user_credentials WHERE subject=?").get(values.subject);
  const agent = database.prepare("SELECT * FROM global_agent_configuration WHERE id=1").get();
  if (!agent) throw new Error("global_agent_configuration_missing");
  const repositoryRows = database.prepare("SELECT * FROM repositories ORDER BY name,url").all();
  const definitions: Record<string, unknown> = {}, aliases = new Map<string, string>();
  for (const repository of repositoryRows) {
    let alias = String(repository.name).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repository";
    const base = alias; let suffix = 2;
    while (definitions[alias]) alias = `${base}-${suffix++}`;
    definitions[alias] = { url: repository.url }; aliases.set(String(repository.url), alias);
  }
  const slsCredentials = new Map<string, { accessKeyId: string; accessKeySecret: string }>();
  const dmsConnections = new Map<string, { url: string; authorization: string }>();
  const serviceDefinitions: Record<string, unknown> = {};
  for (const service of database.prepare("SELECT * FROM services ORDER BY key").all()) {
    const configurations: Record<string, unknown> = {};
    const bound = database.prepare("SELECT * FROM service_repositories WHERE service_id=? ORDER BY alias").all(service.id!);
    for (const deployment of database.prepare("SELECT d.*,e.key AS environment_key FROM service_deployments d JOIN environments e ON e.id=d.environment_id WHERE d.service_id=? ORDER BY e.key").all(service.id!)) {
      const configuration = JSON.parse(String(deployment.config));
      const branches = database.prepare("SELECT * FROM service_deployment_repositories WHERE deployment_id=?").all(deployment.id!);
      const scope: Record<string, unknown> = { repositories: Object.fromEntries(bound.map(repository => [aliases.get(String(repository.url))!, branches.find(branch => branch.repository_id === repository.id)?.base_branch])) };
      if (configuration.dms) {
        const dms = configuration.dms;
        dmsConnections.set(JSON.stringify([dms.url,dms.authorization]), { url: dms.url, authorization: dms.authorization });
        scope.dms = Object.fromEntries(dms.databases.map((target: { instanceAlias: string; schemaName: string }) => [target.schemaName, { alias: target.instanceAlias, schema: target.schemaName }]));
      }
      if (configuration.sls) {
        const sls = configuration.sls;
        slsCredentials.set(JSON.stringify([sls.accessKeyId,sls.accessKeySecret]), { accessKeyId: sls.accessKeyId, accessKeySecret: sls.accessKeySecret });
        scope.sls = sls.targets ? Object.fromEntries(sls.targets.map((target: { name: string; region: string; project: string; logstores: string[] }) => [target.name, { region: target.region, project: target.project, logstores: target.logstores }])) : { [String(deployment.environment_key)]: { region: sls.region, project: sls.project, logstores: sls.logstores } };
      }
      if (configuration.db) scope.mysql = configuration.db.databases.map((target: { url: string; username: string; password: string }) => {
        const url = new URL(target.url);
        return { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 3306), database: decodeURIComponent(url.pathname.slice(1)), username: target.username, password: target.password };
      });
      configurations[String(deployment.environment_key)] = scope;
    }
    serviceDefinitions[String(service.key)] = { name: service.name, description: service.description, environments: configurations };
  }
  if (slsCredentials.size > 1 || dmsConnections.size > 1) throw new Error("multiple_credential_groups_require_owner_review");
  if (credentials?.production_sls_access_key_id && credentials.production_sls_access_key_secret && slsCredentials.size && !slsCredentials.has(JSON.stringify([credentials.production_sls_access_key_id, credentials.production_sls_access_key_secret]))) throw new Error("personal_and_shared_credentials_require_owner_review");
  if (credentials?.production_dms_url && credentials.production_dms_authorization && dmsConnections.size && !dmsConnections.has(JSON.stringify([credentials.production_dms_url, credentials.production_dms_authorization]))) throw new Error("personal_and_shared_credentials_require_owner_review");
  const user: Record<string, unknown> = { version: 1, user: { subject: values.subject }, apiKeys: JSON.parse(String(credentials?.model_api_keys ?? "{}")) };
  if (credentials?.git_private_key) user.ssh = { privateKey: credentials.git_private_key };
  const sls = credentials?.production_sls_access_key_id && credentials.production_sls_access_key_secret ? { accessKeyId: credentials.production_sls_access_key_id, accessKeySecret: credentials.production_sls_access_key_secret } : [...slsCredentials.values()][0];
  if (sls) user.sls = sls;
  const dms = credentials?.production_dms_url && credentials.production_dms_authorization ? { url: credentials.production_dms_url, authorization: credentials.production_dms_authorization } : [...dmsConnections.values()][0];
  if (dms) user.dms = dms;
  const service: Record<string, unknown> = { version: 1, issuesDirectory: "workspaces", agent: { provider: agent.provider, model: agent.model, thinkingLevel: agent.thinking_level, codemode: agent.codemode }, automation: { maxConcurrentIssues: 3 }, repositories: definitions, services: serviceDefinitions };
  if (values["reference-service"]) {
    const reference = parseDocument(await readFile(values["reference-service"], "utf8"));
    if (reference.errors.length) throw new Error("invalid_reference_configuration");
    const data = reference.toJS();
    if (data?.sources) service.sources = data.sources;
    if (data?.automation?.maxConcurrentIssues) service.automation = { maxConcurrentIssues: data.automation.maxConcurrentIssues };
  }
  const mcp: { mcpServers: Record<string, Record<string, unknown>> } = { mcpServers: {} };
  for (const row of database.prepare("SELECT * FROM mcp_services ORDER BY name").all()) {
    const launch = row.transport === "stdio" ? JSON.parse(String(row.stdio)) : undefined;
    if (String(row.name).toLowerCase().includes("playwright") || Array.isArray(launch?.args) && launch.args.some((arg: unknown) => typeof arg === "string" && arg.includes("@playwright/mcp"))) continue;
    mcp.mcpServers[String(row.name)] = row.transport === "stdio" ? { ...JSON.parse(String(row.stdio)), type: "stdio", enabled: Boolean(row.enabled) } : { type: row.transport === "sse" ? "sse" : "streamable-http", url: row.url, ...(row.authorization ? { headers: { Authorization: row.authorization } } : {}), enabled: Boolean(row.enabled) };
  }
  if (values["reference-mcp"]) {
    const reference = JSON.parse(await readFile(values["reference-mcp"], "utf8"));
    for (const name of ["mysql", "dms", "dingtalk"]) if (reference?.mcpServers?.[name]) mcp.mcpServers[name] = reference.mcpServers[name];
  }
  if (!mcp.mcpServers.mysql) mcp.mcpServers.mysql = { type: "stdio", command: "npx", args: ["-y", "@benborla29/mcp-server-mysql@2.0.9"] };
  else if (Array.isArray(mcp.mcpServers.mysql.args)) mcp.mcpServers.mysql.args = mcp.mcpServers.mysql.args.map((value: unknown) => value === "@benborla29/mcp-server-mysql" ? "@benborla29/mcp-server-mysql@2.0.9" : value);
  if (mcp.mcpServers.dms && dms) { mcp.mcpServers.dms.url = dms.url; delete mcp.mcpServers.dms.headers; }
  if (mcp.mcpServers.dingtalk?.url) {
    const url = new URL(String(mcp.mcpServers.dingtalk.url));
    const apiKey = url.searchParams.get("key");
    if (apiKey) { user.dingtalk = { apiKey }; url.searchParams.delete("key"); mcp.mcpServers.dingtalk.url = url.toString(); }
  }
  await mkdir(output, { recursive: true, mode: 0o700 });
  const metadata = await lstat(output);
  if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) throw new Error("insecure_configuration_staging_directory");
  for (const [name, content] of [["service.yaml", stringify(service)], ["user.yaml", stringify(user)], ["mcp.json", JSON.stringify(mcp, null, 2) + "\n"]]) {
    const file = path.join(output, name!);
    const handle = await open(file, "wx", 0o600); created.push(file);
    try { await handle.writeFile(content!); } finally { await handle.close(); }
  }
  console.log(JSON.stringify({ output, files: created.map(file => path.basename(file)), services: Object.keys(serviceDefinitions).length, repositories: Object.keys(definitions).length, preservedServiceKeys: true, liveStateChanged: false }));
} catch {
  let cleanupFailures = 0;
  for (const file of created.reverse()) try { await unlink(file); } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) cleanupFailures++; }
  console.error(cleanupFailures ? "configuration_preparation_failed_cleanup_incomplete" : "configuration_preparation_failed; existing files and live state were preserved"); process.exitCode = 1;
} finally { database.close(); }
