import { capabilityResultText, capabilitySignal, capabilityTextResult } from "./contracts.ts";
import { basicAuthHeaders, responseJson } from "./http-client.ts";
import type { CapabilityConfig, CapabilityInputs } from "./registry.ts";

async function httpJson(config: CapabilityConfig<"mq">, requestPath: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(new URL(requestPath, `http://${config.host}:${config.managementPort}`), {
    redirect: "error",
    headers: { accept: "application/json", ...basicAuthHeaders(config) },
    signal: capabilitySignal(signal),
  });
  return responseJson(response);
}

function rabbitMqPath(action: "overview" | "queues" | "queue" | "bindings", virtualHost: string, queue?: string): string {
  const encodedVirtualHost = encodeURIComponent(virtualHost);
  if (action === "overview") return "/api/overview";
  // WHATWG URLs normalize even percent-encoded dot segments, changing the target scope.
  if (virtualHost === "." || virtualHost === "..") throw new Error("invalid_mq_virtual_host");
  if (action === "queues") return `/api/queues/${encodedVirtualHost}`;
  const encodedQueue = encodeURIComponent(queue!);
  return action === "queue"
    ? `/api/queues/${encodedVirtualHost}/${encodedQueue}`
    : `/api/queues/${encodedVirtualHost}/${encodedQueue}/bindings`;
}

export async function readRabbitMq(config: CapabilityConfig<"mq">, input: CapabilityInputs["mq"], signal?: AbortSignal) {
  const queue = input.queue;
  if ((input.action === "queue" || input.action === "bindings") && (!queue || queue === "." || queue === ".." || queue.includes("\0"))) throw new Error("invalid_mq_queue");
  const requestPath = rabbitMqPath(input.action, config.virtualHost, queue);
  const response = await httpJson(config, requestPath, signal);
  return capabilityTextResult(capabilityResultText({ action: input.action, output: response }), { virtualHost: config.virtualHost });
}
