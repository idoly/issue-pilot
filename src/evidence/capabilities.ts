import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { datasourceUrl, resolveConfiguration, sanitizedConfiguration } from "./configuration.ts";
import type { GrantedRepository } from "../pi/policy.ts";
import { queryMysql, validateReadOnlyQuery } from "./mysql.ts";
import { result } from "./output.ts";

interface DmsProvider {
  provider: "dms";
  image: string;
  profileRoot: string;
  profile: string;
  region: string;
  allowedNacosServers?: string[];
  databases: Array<{ host: string; database: string; dbId: number }>;
}

interface ConnectorConfiguration {
  databaseProviders?: Record<string, DmsProvider>;
  configurationProviders?: Record<string, { nacos?: { allowedServers?: string[] } }>;
  allowedNacosServers?: string[];
}

function nacosServers(configuration: ConnectorConfiguration, service: GrantedRepository, provider?: DmsProvider): string[] {
  return provider?.allowedNacosServers
    ?? configuration.configurationProviders?.[service.environmentKey]?.nacos?.allowedServers
    ?? configuration.allowedNacosServers
    ?? [];
}

async function connectors(): Promise<ConnectorConfiguration> {
  const file = process.env.ISSUE_PILOT_CONNECTORS_FILE;
  if (!file) return {};
  try { return JSON.parse(await readFile(path.resolve(file), "utf8")) as ConnectorConfiguration; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function readConfiguration(pi: ExtensionAPI, repositories: GrantedRepository[], signal?: AbortSignal) {
  const configured = await connectors();
  const resolvedRepositories = [];
  for (const repository of repositories) {
    const provider = configured.databaseProviders?.[repository.environmentKey];
    const resolved = await resolveConfiguration(pi, repository, signal, {}, nacosServers(configured, repository, provider));
    resolvedRepositories.push({ repository: path.basename(repository.repositoryPath), ...sanitizedConfiguration(resolved) });
  }
  return result({ repositories: resolvedRepositories }, {
    serviceKey: repositories[0]!.serviceKey,
    sources: resolvedRepositories.flatMap((repository) => repository.sources),
    missingSources: resolvedRepositories.flatMap((repository) => repository.missingSources),
  });
}

export async function readDatabase(pi: ExtensionAPI, cwd: string, repositories: GrantedRepository[], input: { statement: string }, signal?: AbortSignal) {
  const statement = validateReadOnlyQuery(input.statement);
  const configured = await connectors();
  const candidates: Array<{ service: GrantedRepository; connectionUrl: string }> = [];
  for (const service of repositories) {
    const provider = configured.databaseProviders?.[service.environmentKey];
    const resolved = await resolveConfiguration(pi, service, signal, {}, nacosServers(configured, service, provider));
    try {
      candidates.push({ service, connectionUrl: datasourceUrl(resolved) });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "datasource_url_not_resolved") throw error;
    }
  }
  const unique = [...new Map(candidates.map((candidate) => [candidate.connectionUrl, candidate])).values()];
  if (!unique.length) throw new Error("service_datasource_not_found");
  if (unique.length > 1) throw new Error("multiple_service_datasources_found");
  const { service, connectionUrl } = unique[0]!;
  const provider = configured.databaseProviders?.[service.environmentKey];
  if (!provider || provider.provider !== "dms") {
    const output = await queryMysql(pi, cwd, { connectionUrl, statement }, signal);
    return result({ provider: "mysql", ...output }, { serviceKey: service.serviceKey, repository: path.basename(service.repositoryPath) }, { redact: false });
  }

  const profile = await stat(path.resolve(provider.profileRoot));
  if (!profile.isDirectory() || (profile.mode & 0o077) !== 0) throw new Error("insecure_aliyun_profile_root");
  const databaseUrl = new URL(connectionUrl);
  const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ""));
  const database = provider.databases.find((candidate) => candidate.host === databaseUrl.hostname && candidate.database === databaseName);
  if (!database || !Number.isSafeInteger(database.dbId) || database.dbId <= 0) throw new Error("dms_database_not_allowed");
  const execution = await pi.exec("podman", [
    "run", "--rm", "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--read-only", "--tmpfs", "/tmp:size=64m,mode=1777",
    "--volume", `${path.resolve(provider.profileRoot)}:/root/.aliyun:ro,z`, provider.image,
    "aliyun", "--profile", provider.profile, "dms-enterprise", "ExecuteScript", "--RegionId", provider.region, "--DbId", String(database.dbId), "--Script", statement,
  ], { timeout: 30_000, ...(signal ? { signal } : {}) });
  if (execution.code !== 0) throw new Error("dms_query_failed");
  let payload: unknown;
  try { payload = JSON.parse(execution.stdout); } catch { payload = { output: execution.stdout }; }
  return result({ provider: "dms", database: database.database, result: payload }, { serviceKey: service.serviceKey, repository: path.basename(service.repositoryPath) }, { redact: false });
}
