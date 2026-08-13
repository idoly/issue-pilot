import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { IssuePolicy } from "../pi/policy.ts";
import { capabilityResultText, capabilitySignal, capabilityTextResult } from "./contracts.ts";
import { basicAuthHeaders, responseJson } from "./http-client.ts";

const limits = issuePilotConfig.limits.capability;

function elasticsearchUrl(baseUrl: string, suffix: string): URL {
  const endpoint = new URL(baseUrl);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/${suffix}`;
  return endpoint;
}

async function elasticsearchRead(config: Record<string, unknown>, input: { action: "search" | "count" | "mapping"; query: Record<string, unknown>; limit?: number }, signal?: AbortSignal): Promise<unknown> {
  const suffix = input.action === "mapping" ? "_mapping" : input.action === "count" ? "_count" : "_search";
  const requestBody = input.action === "mapping" ? undefined : JSON.stringify({ query: input.query, ...(input.action === "search" && input.limit !== undefined ? { size: input.limit } : {}) });
  const response = await fetch(elasticsearchUrl(config.url as string, suffix), {
    method: requestBody ? "POST" : "GET",
    redirect: "error",
    headers: { accept: "application/json", ...(requestBody ? { "content-type": "application/json" } : {}), ...basicAuthHeaders(config) },
    ...(requestBody ? { body: requestBody } : {}),
    signal: capabilitySignal(signal),
  });
  return responseJson(response);
}

export async function readElasticsearch(policy: IssuePolicy, config: Record<string, unknown>, input: { action: "search" | "count" | "mapping"; query?: Record<string, unknown>; limit?: number }, signal?: AbortSignal) {
  const grant = policy.service.es;
  if (!grant) throw new Error("es_scope_not_granted_for_service");
  if (typeof config.url !== "string" || typeof config.username !== "string" || (config.password !== undefined && typeof config.password !== "string")) throw new Error("es_configuration_changed");
  const query = input.query ?? { match_all: {} };
  if (!query || typeof query !== "object") throw new Error("invalid_es_query");
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > limits.elasticsearch.results)) throw new Error("invalid_es_limit");
  const response = await elasticsearchRead(config, { action: input.action, query, ...(input.limit === undefined ? {} : { limit: input.limit }) }, signal);
  return capabilityTextResult(capabilityResultText({ action: input.action, output: response }), { deploymentId: grant.deploymentId });
}
