import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { datasourceUrl, resolveConfiguration, sanitizedConfiguration } from "./configuration.ts";
import type { GrantedRepository } from "../pi/policy.ts";
import { queryMysql, validateReadOnlyQuery } from "./mysql.ts";
import { result } from "./output.ts";

interface ConnectorConfiguration {
  configurationProviders?: Record<string, { nacos?: { allowedServers?: string[] } }>;
  allowedNacosServers?: string[];
}

function nacosServers(configuration: ConnectorConfiguration, service: GrantedRepository): string[] {
  return configuration.configurationProviders?.[service.environmentKey]?.nacos?.allowedServers
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
    const resolved = await resolveConfiguration(pi, repository, signal, {}, nacosServers(configured, repository));
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
    const resolved = await resolveConfiguration(pi, service, signal, {}, nacosServers(configured, service));
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
  const output = await queryMysql(pi, cwd, { connectionUrl, statement }, signal);
  return result({ provider: "mysql", ...output }, { serviceKey: service.serviceKey, repository: path.basename(service.repositoryPath) }, { redact: false });
}
