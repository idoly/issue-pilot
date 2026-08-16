import { capabilityResultText, capabilitySignal, capabilityTextResult } from "./contracts.ts";
import { basicAuthHeaders, responseJson } from "./http-client.ts";
import type { CapabilityConfig, CapabilityInputs } from "./registry.ts";

function elasticsearchUrl(baseUrl: string, suffix: string): URL {
  const endpoint = new URL(baseUrl);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/${suffix}`;
  return endpoint;
}

async function elasticsearchRead(config: CapabilityConfig<"es">, input: CapabilityInputs["es"] & { query: Record<string, unknown> }, signal?: AbortSignal): Promise<unknown> {
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

export async function readElasticsearch(config: CapabilityConfig<"es">, input: CapabilityInputs["es"], signal?: AbortSignal) {
  const query = input.query ?? { match_all: {} };
  const response = await elasticsearchRead(config, { action: input.action, query, ...(input.limit === undefined ? {} : { limit: input.limit }) }, signal);
  return capabilityTextResult(capabilityResultText({ action: input.action, output: response }), {});
}
