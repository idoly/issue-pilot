import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { datasourceUrl, resolveConfigurations, sanitizedConfiguration } from "./configuration.ts";
import type { GrantedRepository } from "../pi/policy.ts";
import { queryMysql, validateReadOnlyQuery } from "./mysql.ts";
import { result } from "./output.ts";

export async function readConfiguration(pi: ExtensionAPI, repositories: GrantedRepository[], input: { scope?: string; propertyPrefix?: string } = {}, signal?: AbortSignal) {
  const scopeFilter = input.scope?.trim();
  const prefixFilter = input.propertyPrefix?.trim();
  const resolvedRepositories = [];
  let matchedScope = !scopeFilter;
  for (const repository of repositories) {
    const configurations = await resolveConfigurations(pi, repository, signal);
    const selected = configurations.filter(({ scope }) => !scopeFilter || scope === scopeFilter);
    if (selected.length) matchedScope = true;
    resolvedRepositories.push({
      repository: path.basename(repository.repositoryPath),
      configurations: selected.map(({ scope, configuration }) => {
        const visible = sanitizedConfiguration(configuration);
        if (scopeFilter || prefixFilter) {
          const properties = prefixFilter ? Object.fromEntries(Object.entries(visible.properties).filter(([key]) => key.startsWith(prefixFilter))) : visible.properties;
          return { scope, properties, sources: visible.sources, missingSources: visible.missingSources };
        }
        return { scope, propertyCount: Object.keys(visible.properties).length, sources: visible.sources, missingSources: visible.missingSources };
      }),
    });
  }
  if (!matchedScope) throw new Error("service_configuration_scope_not_found");
  return result({ repositories: resolvedRepositories }, {
    serviceKey: repositories[0]!.serviceKey,
    scope: scopeFilter,
    propertyPrefix: prefixFilter,
  });
}

export async function readDatabase(pi: ExtensionAPI, cwd: string, repositories: GrantedRepository[], input: { statement: string }, signal?: AbortSignal) {
  const statement = validateReadOnlyQuery(input.statement);
  const candidates: Array<{ service: GrantedRepository; scope: string; connectionUrl: string }> = [];
  for (const service of repositories) {
    const configurations = await resolveConfigurations(pi, service, signal);
    for (const { scope, configuration } of configurations) {
      try {
        candidates.push({ service, scope, connectionUrl: datasourceUrl(configuration) });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "datasource_url_not_resolved") throw error;
      }
    }
  }
  const unique = [...new Map(candidates.map((candidate) => [candidate.connectionUrl, candidate])).values()];
  if (!unique.length) throw new Error("service_datasource_not_found");
  if (unique.length > 1) throw new Error("multiple_service_datasources_found");
  const { service, scope, connectionUrl } = unique[0]!;
  const output = await queryMysql(pi, cwd, { connectionUrl, statement }, signal);
  return result({ provider: "mysql", ...output }, { serviceKey: service.serviceKey, repository: path.basename(service.repositoryPath), configurationScope: scope }, { redact: false });
}
