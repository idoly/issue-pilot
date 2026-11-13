import type { ImageContent } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export interface AgentMessageScope {
  serviceId: string;
  environmentId: string;
}

export interface PendingAgentMessage {
  id: string;
  message: string;
  images: ImageContent[];
  scope: AgentMessageScope;
}

export interface AgentMessageRequest {
  id: string;
  subject: string;
}

type DeliveryState = "queued" | "started" | "rejected";

const deliveryType = "issue-pilot-user-delivery";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("agent_message_state_invalid");
  return value as Record<string, unknown>;
}

function deliveryState(value: unknown, allowRejected = true): DeliveryState {
  if (value !== "queued" && value !== "started" && value !== "rejected") throw new Error("agent_message_state_invalid");
  if (!allowRejected && value === "rejected") throw new Error("agent_message_state_invalid");
  return value;
}

/** One transition entry, validated in one place for receipts, pending work and cancellation. */
function deliveryTransition(entry: { type: string; customType?: string; data?: unknown }): { entryId: string; state: DeliveryState } | undefined {
  if (entry.type !== "custom" || entry.customType !== deliveryType) return undefined;
  const data = object(entry.data);
  if (data.version !== 1 || typeof data.entryId !== "string") throw new Error("agent_message_state_invalid");
  return { entryId: data.entryId, state: deliveryState(data.state) };
}

export function agentMessageReceipt(manager: SessionManager, request: AgentMessageRequest) {
  const entries = manager.getEntries();
  const entry = entries.find(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === "issue-pilot-user" &&
      entry.data &&
      typeof entry.data === "object" &&
      "request" in entry.data &&
      (entry.data.request as AgentMessageRequest)?.id === request.id &&
      (entry.data.request as AgentMessageRequest)?.subject === request.subject,
  );
  if (!entry || entry.type !== "custom") return undefined;
  const data = object(entry.data);
  const delivery = data.delivery ? object(data.delivery) : undefined;
  // Legacy entries without a delivery snapshot are treated as already dispatched; transitions still override.
  let state: DeliveryState = delivery?.state === undefined ? "started" : deliveryState(delivery.state);
  for (const item of entries) {
    const transition = deliveryTransition(item);
    if (transition?.entryId === entry.id) state = transition.state;
  }
  return { state, message: data.message, images: data.images ?? [] };
}

/** Read only explicitly queued inputs; historical visible messages are never adopted as pending work. */
export function pendingAgentMessages(manager: SessionManager, requestedId?: string): PendingAgentMessage[] {
  const branch = manager.getBranch();
  const states = new Map<string, DeliveryState>();
  for (const entry of branch) {
    const transition = deliveryTransition(entry);
    if (transition) states.set(transition.entryId, transition.state);
  }
  const pending: PendingAgentMessage[] = [];
  const known = new Set(states.keys());
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== "issue-pilot-user") continue;
    if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) continue;
    const data = object(entry.data);
    if (data.delivery === undefined) continue;
    const delivery = object(data.delivery);
    if (delivery.version !== 1 || typeof delivery.serviceId !== "string" || typeof delivery.environmentId !== "string" || typeof data.message !== "string")
      throw new Error("agent_message_state_invalid");
    const deliveryStatus = deliveryState(delivery.state, false);
    const images = data.images ?? [];
    if (!Array.isArray(images) || !images.every((image) => image && typeof image === "object" && image.type === "image" && typeof image.mimeType === "string" && typeof image.data === "string"))
      throw new Error("agent_message_state_invalid");
    known.add(entry.id);
    if ((states.get(entry.id) ?? deliveryStatus) !== "queued") continue;
    pending.push({ id: entry.id, message: data.message, images: images as ImageContent[], scope: { serviceId: delivery.serviceId, environmentId: delivery.environmentId } });
  }
  if (requestedId && !known.has(requestedId)) throw new Error("agent_message_state_changed");
  return pending;
}

/** Finish admission before execution is queued; credentials are never stored in delivery metadata. */
export function appendAgentMessage(
  manager: SessionManager,
  scope: AgentMessageScope,
  message: string,
  images: ImageContent[],
  request?: AgentMessageRequest,
  state: "queued" | "started" = "queued",
): string {
  return manager.appendCustomEntry("issue-pilot-user", {
    message,
    ...(request ? { request } : {}),
    ...(images.length ? { images } : {}),
    delivery: { version: 1, state, serviceId: scope.serviceId, environmentId: scope.environmentId },
  });
}

/** Validate the current business scope before selecting the oldest unstarted input. */
export function selectAgentMessage(manager: SessionManager, scope: AgentMessageScope, requestedId?: string): PendingAgentMessage | undefined {
  const pending = pendingAgentMessages(manager, requestedId);
  if (requestedId && !pending.some((message) => message.id === requestedId)) return undefined;
  const rejected = pending.filter((message) => message.scope.serviceId !== scope.serviceId || message.scope.environmentId !== scope.environmentId);
  for (const message of rejected) manager.appendCustomEntry(deliveryType, { version: 1, entryId: message.id, state: "rejected", reason: "scope_changed" });
  if (rejected.length) throw new Error("agent_message_scope_changed");
  return pending[0];
}

/** Keep visible inputs, but never replay explicitly cancelled queued work on retry. */
export function cancelPendingAgentMessages(manager: SessionManager): void {
  for (const message of pendingAgentMessages(manager)) {
    manager.appendCustomEntry(deliveryType, { version: 1, entryId: message.id, state: "rejected", reason: "cancelled" });
  }
}

/** A started marker is conservative: a crash immediately afterwards must not replay the input. */
export function startAgentMessage(manager: SessionManager, id: string, scope: AgentMessageScope): void {
  const pending = selectAgentMessage(manager, scope, id);
  if (pending?.id !== id) throw new Error("agent_message_state_changed");
  manager.appendCustomEntry(deliveryType, { version: 1, entryId: id, state: "started" });
}

/** Only after Pi confirms its sole queued steer was removed, return that same admission to the queue. */
export function requeueAgentMessage(manager: SessionManager, id: string): void {
  manager.appendCustomEntry(deliveryType, { version: 1, entryId: id, state: "queued" });
}
