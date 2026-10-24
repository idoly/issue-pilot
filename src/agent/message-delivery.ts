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

const deliveryType = "issue-pilot-user-delivery";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("agent_message_state_invalid");
  return value as Record<string, unknown>;
}

/** Read only explicitly queued inputs; historical visible messages are never adopted as pending work. */
export function pendingAgentMessages(manager: SessionManager, requestedId?: string): PendingAgentMessage[] {
  const branch = manager.getBranch();
  const delivered = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== deliveryType) continue;
    const data = object(entry.data);
    if (data.version !== 1 || typeof data.entryId !== "string" || (data.state !== "started" && data.state !== "rejected")) throw new Error("agent_message_state_invalid");
    delivered.add(data.entryId);
  }
  const pending: PendingAgentMessage[] = [];
  const known = new Set(delivered);
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== "issue-pilot-user" || delivered.has(entry.id)) continue;
    if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) continue;
    const data = object(entry.data);
    if (data.delivery === undefined) continue;
    const delivery = object(data.delivery);
    if (delivery.version !== 1 || delivery.state !== "queued" || typeof delivery.serviceId !== "string" || typeof delivery.environmentId !== "string" || typeof data.message !== "string") throw new Error("agent_message_state_invalid");
    const images = data.images ?? [];
    if (!Array.isArray(images) || !images.every(image => image && typeof image === "object" && image.type === "image" && typeof image.mimeType === "string" && typeof image.data === "string")) throw new Error("agent_message_state_invalid");
    known.add(entry.id);
    pending.push({ id: entry.id, message: data.message, images: images as ImageContent[], scope: { serviceId: delivery.serviceId, environmentId: delivery.environmentId } });
  }
  if (requestedId && !known.has(requestedId)) throw new Error("agent_message_state_changed");
  return pending;
}

/** Finish admission before execution is queued; credentials are never stored in delivery metadata. */
export function appendQueuedAgentMessage(manager: SessionManager, scope: AgentMessageScope, message: string, images: ImageContent[]): string {
  return manager.appendCustomEntry("issue-pilot-user", {
    message,
    ...(images.length ? { images } : {}),
    delivery: { version: 1, state: "queued", serviceId: scope.serviceId, environmentId: scope.environmentId },
  });
}

/** Validate the current business scope before selecting the oldest unstarted input. */
export function selectAgentMessage(manager: SessionManager, scope: AgentMessageScope, requestedId?: string): PendingAgentMessage | undefined {
  const pending = pendingAgentMessages(manager, requestedId);
  if (requestedId && !pending.some(message => message.id === requestedId)) return undefined;
  const rejected = pending.filter(message => message.scope.serviceId !== scope.serviceId || message.scope.environmentId !== scope.environmentId);
  for (const message of rejected) manager.appendCustomEntry(deliveryType, { version: 1, entryId: message.id, state: "rejected", reason: "scope_changed" });
  if (rejected.length) throw new Error("agent_message_scope_changed");
  return pending[0];
}

/** A started marker is conservative: a crash immediately afterwards must not replay the input. */
export function startAgentMessage(manager: SessionManager, id: string, scope: AgentMessageScope): void {
  const pending = selectAgentMessage(manager, scope, id);
  if (pending?.id !== id) throw new Error("agent_message_state_changed");
  manager.appendCustomEntry(deliveryType, { version: 1, entryId: id, state: "started" });
}
