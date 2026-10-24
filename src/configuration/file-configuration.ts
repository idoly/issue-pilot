import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseDocument } from "yaml";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { environments, globalAgentConfiguration, mcpServices, repositories, serviceDeployments, serviceRepositories, services, subjects, userCredentials } from "../db/schema.ts";
import { AGENT_CODEMODE_MODES, AGENT_THINKING_LEVELS, type CapabilityConfiguration } from "../domain/contracts.ts";
import { parseCapabilityConfiguration, parseDmsConnectionConfiguration, parseSlsConnectionConfiguration } from "../capabilities/registry.ts";
import { parseAgentRuntime } from "./pi-runtime.ts";
import { parseMcpImport } from "./mcp.ts";
import { applyServiceConfiguration, prepareServiceConfiguration } from "../http/service-configuration.ts";

import type { DingtalkSourceSettings, DingtalkUserSettings, FileConfigurationState } from "./contracts.ts";
export type { FileConfigurationState } from "./contracts.ts";
import { FileConfigurationError, queryTargets, repositoryAddress, fileRecord as record, userFileLayout, dingtalkFieldConfiguration, validateDingtalkSource } from "./file-layout.ts";
export { FileConfigurationError } from "./file-layout.ts";
const fail = (): never => { throw new FileConfigurationError("invalid_file_configuration"); };
function text(value: unknown): string { if (typeof value !== "string" || !value.trim() || value.includes("\0")) return fail(); return value.trim(); }
function secret(value: unknown): string { text(value); return value as string; }
function optionalRecord(value: unknown) { return value === undefined ? {} : record(value); }
function environmentValues(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    if (process.env[name] === undefined) throw new FileConfigurationError("file_configuration_environment_missing");
    return process.env[name]!;
  });
  if (Array.isArray(value)) return value.map(environmentValues);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, environmentValues(entry)]));
  return value;
}
async function readConfiguration(root: string, name: string): Promise<Record<string, unknown> | undefined> {
  const file = path.join(root, name);
  const metadata = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!metadata) return undefined;
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new FileConfigurationError("insecure_file_configuration");
  try {
    const source = await readFile(file, "utf8");
    if (name.endsWith(".json")) return record(environmentValues(JSON.parse(source)));
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length) return fail();
    return record(environmentValues(document.toJS({ maxAliasCount: 50 })));
  } catch (error) {
    if (error instanceof FileConfigurationError) throw error;
    // YAML/JSON errors may quote the source, including credentials.
    return fail();
  }
}
function same(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }
function credentialInput(config: CapabilityConfiguration): Record<string, unknown> {
  return {
    ...(config.dms ? { dms: { url: config.dms.url, databases: config.dms.databases, credentialUpdate: { mode: "replace", values: { authorization: config.dms.authorization } } } } : {}),
    ...(config.sls ? { sls: { region: config.sls.region, project: config.sls.project, logstores: config.sls.logstores, ...(config.sls.targets ? { targets: config.sls.targets } : {}), credentialUpdate: { mode: "replace", values: { accessKeyId: config.sls.accessKeyId, accessKeySecret: config.sls.accessKeySecret } } } } : {}),
  };
}

export async function loadDingtalkUserSettings(stateRoot: string, subject: string): Promise<DingtalkUserSettings> {
  const layout = userFileLayout(await readConfiguration(stateRoot, "user.yaml"));
  const own = optionalRecord(layout.users[subject]?.dingtalk), shared = optionalRecord(layout.shared.dingtalk);
  validateDingtalkSource(own.source);
  const source = own.source === undefined ? undefined : structuredClone(own.source) as DingtalkSourceSettings;
  if (source) { source.mcp = text(source.mcp); source.url = text(source.url); source.assignee = text(source.assignee); }
  const fields = { ...dingtalkFieldConfiguration(shared.fields), ...dingtalkFieldConfiguration(own.fields) };
  return { fields, ...(source ? { source } : {}) };
}

/** Files are authoritative; SQLite retains the validated projection and historical identities. Runs before Agent startup. */
export async function applyFileConfiguration(database: Database, stateRoot: string): Promise<FileConfigurationState> {
  const [serviceFile, userFile, mcpFile] = await Promise.all([readConfiguration(stateRoot, "service.yaml"), readConfiguration(stateRoot, "user.yaml"), readConfiguration(stateRoot, "mcp.json")]);
  if (serviceFile && serviceFile.version !== 2) return fail();
  if (serviceFile?.sources !== undefined) throw new FileConfigurationError("sources_belong_in_user_file");
  const userLayout = userFileLayout(userFile);
  const status: FileConfigurationState = { services: Boolean(serviceFile), mcp: Boolean(mcpFile) };
  if (!serviceFile && !userFile && !mcpFile) return status;
  try {
    const dms = optionalRecord(userLayout.shared.dms), sls = optionalRecord(userLayout.shared.sls), dingtalk = optionalRecord(userLayout.shared.dingtalk);
    dingtalkFieldConfiguration(dingtalk.fields);
    const mcpEntries = structuredClone(optionalRecord(mcpFile?.mcpServers));
    if (Object.keys(dms).length && mcpEntries.dms) {
      const entry = record(mcpEntries.dms);
      entry.url = dms.url ?? entry.url;
      entry.headers = { Authorization: secret(dms.authorization) };
    }
    if ((dingtalk.apiKey !== undefined || dingtalk.url !== undefined) && mcpEntries.dingtalk) {
      const entry = record(mcpEntries.dingtalk);
      const url = new URL(text(dingtalk.url ?? entry.url));
      url.searchParams.set("key", secret(dingtalk.apiKey)); entry.url = url.toString();
    }
    const dmsServer = optionalRecord(mcpEntries.dms);
    const dmsConnection = Object.keys(dms).length ? parseDmsConnectionConfiguration({ url: dms.url ?? dmsServer.url, authorization: dms.authorization }) : undefined;
    const slsConnection = Object.keys(sls).length ? parseSlsConnectionConfiguration(sls) : undefined;
    const mysqlTemplate = mcpEntries.mysql;
    if (mysqlTemplate) delete mcpEntries.mysql;
    const generatedMysql: Record<string, unknown> = {};
    const serviceDefinitions = optionalRecord(serviceFile?.services);
    const repositoryDefinitions = optionalRecord(serviceFile?.repositories);
    const agent = optionalRecord(serviceFile?.agent);
    const automation = optionalRecord(serviceFile?.automation);
    if (automation.maxConcurrentIssues !== undefined) {
      const maximum = automation.maxConcurrentIssues;
      if (!Number.isInteger(maximum) || Number(maximum) < 1 || Number(maximum) > 64) return fail();
      status.maxConcurrentIssues = Number(maximum);
    }
    // A changed Git worktree root needs its own explicit filesystem/Git migration.
    if (serviceFile?.issuesDirectory !== undefined && !["workspaces", "./workspaces"].includes(text(serviceFile.issuesDirectory))) throw new FileConfigurationError("file_configuration_work_directory_requires_migration");
    await database.transaction(async transaction => {
      const managedUsers: string[] = [];
      for (const [userSubject, personal] of Object.entries(userLayout.users)) {
        const [owner] = await transaction.select().from(subjects).where(eq(subjects.subject, userSubject));
        if (!owner) throw new FileConfigurationError("file_configuration_user_not_active");
        managedUsers.push(userSubject);
        const apiKeys = Object.fromEntries(Object.entries(optionalRecord(personal.apiKeys)).map(([provider, value]) => [text(provider), secret(value)]));
        const ssh = optionalRecord(personal.ssh), personalDms = optionalRecord(personal.dms), personalSls = optionalRecord(personal.sls);
        dingtalkFieldConfiguration(optionalRecord(personal.dingtalk).fields);
        validateDingtalkSource(optionalRecord(personal.dingtalk).source);
        const privateKey = ssh.privateKey === undefined ? "" : secret(ssh.privateKey);
        if (privateKey && !/^-----BEGIN (?:OPENSSH|RSA|EC|PRIVATE|ENCRYPTED)/.test(privateKey)) return fail();
        const ownDms = Object.keys(personalDms).length ? parseDmsConnectionConfiguration(personalDms) : undefined;
        const ownSls = Object.keys(personalSls).length ? parseSlsConnectionConfiguration(personalSls) : undefined;
        const values = { modelApiKeys: apiKeys, gitPrivateKey: privateKey ? privateKey.trimEnd() + "\n" : "", productionDmsUrl: ownDms?.url ?? "", productionDmsAuthorization: ownDms?.authorization ?? "", productionSlsAccessKeyId: ownSls?.accessKeyId ?? "", productionSlsAccessKeySecret: ownSls?.accessKeySecret ?? "" };
        const [existing] = await transaction.select().from(userCredentials).where(eq(userCredentials.subject, userSubject));
        if (!existing || !Object.entries(values).every(([key, value]) => same(existing[key as keyof typeof values], value))) await transaction.insert(userCredentials).values({ subject: userSubject, ...values }).onConflictDoUpdate({ target: userCredentials.subject, set: { ...values, updatedAt: new Date() } });
      }
      if (userFile) status.userSubjects = managedUsers;
      if (Object.keys(agent).length) {
        const provider = text(agent.provider), model = text(agent.model), thinkingLevel = text(agent.thinkingLevel ?? "medium"), codemode = text(agent.codemode ?? "on");
        if (!AGENT_THINKING_LEVELS.includes(thinkingLevel as typeof AGENT_THINKING_LEVELS[number]) || !AGENT_CODEMODE_MODES.includes(codemode as typeof AGENT_CODEMODE_MODES[number])) return fail();
        const [existing] = await transaction.select().from(globalAgentConfiguration).limit(1);
        const values = { provider, model, thinkingLevel, codemode: codemode as typeof AGENT_CODEMODE_MODES[number], runtime: parseAgentRuntime(agent.runtime ?? {}) };
        if (!existing || !Object.entries(values).every(([key, value]) => same(existing[key as keyof typeof values], value))) await transaction.insert(globalAgentConfiguration).values({ id: 1, ...values }).onConflictDoUpdate({ target: globalAgentConfiguration.id, set: { ...values, updatedAt: new Date() } });
      }
      for (const [alias, raw] of Object.entries(repositoryDefinitions)) {
        const url = repositoryAddress(raw);
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(alias) || url.startsWith("-")) return fail();
        await transaction.insert(repositories).values({ name: alias, url }).onConflictDoNothing();
      }
      const environmentRows = await transaction.select().from(environments);
      for (const [key, raw] of Object.entries(serviceDefinitions)) {
        if (!/^[a-z0-9][a-z0-9._-]*$/.test(key)) return fail();
        const definition = record(raw), scopes = record(definition.environments);
        const aliases = [...new Set(Object.values(scopes).flatMap(value => Object.keys(record(record(value).repositories))))];
        const [existingService] = await transaction.select().from(services).where(eq(services.key, key));
        const serviceId = existingService?.id ?? randomUUID();
        const oldRepositories = await transaction.select().from(serviceRepositories).where(eq(serviceRepositories.serviceId, serviceId));
        const deployments = [];
        for (const [environmentKey, value] of Object.entries(scopes)) {
          const scope = record(value), branches = record(scope.repositories);
          if (Object.keys(scope).some(key => !["repositories", "dms", "sls", "mysql"].includes(key))) return fail();
          if (environmentKey === "dev") {
            // Development declarations may reference production/test evidence, but
            // must not silently create a second, differently configured source.
            for (const kind of ["dms", "sls"] as const) if (scope[kind]) {
              const available = Object.entries(scopes).filter(([key]) => key !== "dev").flatMap(([, raw]) => queryTargets(kind, record(raw)[kind]).map(target => target.value));
              for (const { value: raw } of queryTargets(kind, scope[kind])) {
                const target = record(raw);
                const matches = available.some(raw => {
                  const source = record(raw);
                  return kind === "dms" ? target.alias === source.alias && target.schema === source.schema
                    : target.region === source.region && target.project === source.project && Array.isArray(target.logstores) && Array.isArray(source.logstores) && same([...target.logstores].sort(), [...source.logstores].sort());
                });
                if (!matches) throw new FileConfigurationError("development_query_target_requires_deployment");
              }
            }
          }
          const environment = environmentRows.find(row => row.key === environmentKey);
          if (!environment) return fail();
          const [existingDeployment] = await transaction.select().from(serviceDeployments).where(and(eq(serviceDeployments.serviceId, serviceId), eq(serviceDeployments.environmentId, environment.id)));
          const configuration: CapabilityConfiguration = {};
          if (environmentKey !== "dev" && scope.dms) {
            if (!dmsConnection) return fail();
            const targets = queryTargets("dms", scope.dms).map(({ value }) => {
              const target = record(value), instanceAlias = text(target.alias), schemaName = text(target.schema);
              const previous = existingDeployment?.config.dms?.url === dmsConnection.url ? existingDeployment.config.dms.databases.find(database => database.instanceAlias === instanceAlias && database.schemaName === schemaName) : undefined;
              return { instanceAlias, schemaName, ...(previous ?? {}) };
            });
            configuration.dms = parseCapabilityConfiguration("dms", { ...dmsConnection, databases: targets });
          }
          if (environmentKey !== "dev" && scope.sls) {
            if (!slsConnection) return fail();
            const targets = queryTargets("sls", scope.sls, environmentKey).map(({ name, value }) => {
              const target = record(value);
              return { name, region: text(target.region), project: text(target.project), logstores: target.logstores };
            });
            if (!targets.length) return fail();
            configuration.sls = parseCapabilityConfiguration("sls", { ...slsConnection, ...targets[0], ...(targets.length > 1 ? { targets } : {}) });
          }
          if (scope.mysql !== undefined) {
            if (!mysqlTemplate || !Array.isArray(scope.mysql)) return fail();
            for (const value of scope.mysql) {
              const mysql = record(value), database = text(mysql.database);
              if (Object.keys(mysql).some(key => !["host", "port", "username", "password", "database"].includes(key))) return fail();
              const template = record(structuredClone(mysqlTemplate));
              const host = text(mysql.host), rawPort = mysql.port ?? 3306;
              const port = typeof rawPort === "number" || typeof rawPort === "string" ? Number(rawPort) : NaN;
              if (!Number.isInteger(port) || port < 1 || port > 65535 || database.length > 255) return fail();
              const displayName = `mysql-${key}-${environmentKey}-${database}`;
              const name = displayName.length <= 100 ? displayName : `${displayName.slice(0, 72)}-${createHash("sha256").update(displayName).digest("hex").slice(0, 16)}`;
              if (generatedMysql[name]) return fail();
              generatedMysql[name] = { ...template, type: "stdio", env: { ...optionalRecord(template.env), MYSQL_HOST: host, MYSQL_PORT: String(port), MYSQL_USER: text(mysql.username), MYSQL_PASS: secret(mysql.password), MYSQL_DB: database, ALLOW_INSERT_OPERATION: "false", ALLOW_UPDATE_OPERATION: "false", ALLOW_DELETE_OPERATION: "false" } };
            }
          }
          deployments.push({ environmentKey, repositoryBranches: Object.entries(branches).map(([repositoryAlias, branch]) => ({ repositoryAlias, baseBranch: text(branch) })), capabilities: Object.keys(configuration), ...credentialInput(configuration) });
        }
        const input = { name: text(definition.name ?? key), description: typeof definition.description === "string" ? definition.description : "", repositories: aliases.map(alias => {
          const url = repositoryAddress(repositoryDefinitions[alias]);
          const previous = oldRepositories.find(repository => repository.url === url);
          return { ...(previous ? { id: previous.id } : {}), alias, url };
        }), deployments };
        const prepared = await prepareServiceConfiguration({ executor: transaction, serviceId, input });
        if (!existingService) await transaction.insert(services).values({ id: serviceId, key, name: input.name, description: input.description });
        await applyServiceConfiguration({ executor: transaction, serviceId, prepared, ...(!existingService || existingService.name !== input.name || existingService.description !== input.description ? { serviceUpdate: { name: input.name, description: input.description } } : {}) });
      }
      if (mcpFile) {
        const entries = { ...mcpEntries, ...generatedMysql };
        const inputs = Object.keys(entries).length ? parseMcpImport({ mcpServers: entries }) : [];
        status.mcpServiceNames = inputs.map(input => input.name);
        const previous = await transaction.select().from(mcpServices);
        for (const input of inputs) {
          const old = previous.find(row => row.name === input.name);
          if (!old || !Object.entries(input).every(([key, value]) => same(old[key as keyof typeof input], value))) await transaction.insert(mcpServices).values({ id: old?.id ?? createHash("sha256").update(input.name).digest("hex").slice(0, 24), ...input }).onConflictDoUpdate({ target: mcpServices.name, set: { ...input, updatedAt: new Date() } });
        }
        for (const old of previous) if (old.enabled && !inputs.some(input => input.name === old.name)) await transaction.update(mcpServices).set({ enabled: false, updatedAt: new Date() }).where(eq(mcpServices.id, old.id));
      }
    });
    return status;
  } catch (error) {
    if (error instanceof FileConfigurationError) throw error;
    // SQL and validation exceptions can contain private configuration values.
    throw new FileConfigurationError("invalid_file_configuration");
  }
}
