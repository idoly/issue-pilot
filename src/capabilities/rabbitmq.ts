import type { IssuePolicy } from "../pi/policy.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { capabilityResultText, capabilitySignal, capabilityTextResult } from "./contracts.ts";
import { basicAuthHeaders, responseJson } from "./http-client.ts";

const limits = issuePilotConfig.limits.capability;

async function httpJson(config: Record<string, unknown>, requestPath: string, signal?: AbortSignal): Promise<unknown> {
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
  if (action === "queues") return `/api/queues/${encodedVirtualHost}`;
  const encodedQueue = encodeURIComponent(queue!);
  return action === "queue"
    ? `/api/queues/${encodedVirtualHost}/${encodedQueue}`
    : `/api/queues/${encodedVirtualHost}/${encodedQueue}/bindings`;
}

export async function readRabbitMq(policy: IssuePolicy, config: Record<string, unknown>, input: { action: "overview" | "queues" | "queue" | "bindings"; queue?: string }, signal?: AbortSignal) {
  const grant = policy.service.mq;
  if (!grant) throw new Error("mq_scope_not_granted_for_service");
  if (config.virtualHost !== grant.virtualHost || typeof config.host !== "string" || !Number.isInteger(config.port) || !Number.isInteger(config.managementPort) || typeof config.username !== "string" || typeof config.password !== "string") throw new Error("mq_configuration_changed");
  const queue = input.queue?.trim();
  if ((input.action === "queue" || input.action === "bindings") && (!queue || queue.length > limits.rabbitmq.queueChars || queue.includes("\0"))) throw new Error("invalid_mq_queue");
  const requestPath = rabbitMqPath(input.action, config.virtualHost as string, queue);
  const response = await httpJson(config, requestPath, signal);
  return capabilityTextResult(capabilityResultText({ action: input.action, output: response }), { deploymentId: grant.deploymentId, virtualHost: grant.virtualHost });
}
