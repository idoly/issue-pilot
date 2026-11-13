import type { JsonAgentSessionEvent, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { DomainError } from "../domain/errors.ts";

export interface QueryResultReference {
  sessionId: string;
  entryId: string;
}

type Completion = Extract<JsonAgentSessionEvent, { type: "tool_execution_end" }>;
export type QueryCompletion = Completion & { result: Completion["result"] & { queryResult: QueryResultReference } };
const customType = "issue-pilot-query-result";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Only native, successful inline evidence has a complete-result reader. Exports remain ordinary files. */
function nativeResult(value: unknown): value is { content: TextContent[]; details: Record<string, unknown> } {
  if (!record(value) || !record(value.details) || !Array.isArray(value.content) || !value.content.length) return false;
  return (
    (value.details.provider === "aliyun-sls-cli" || value.details.provider === "aliyun-dms-mcp") &&
    value.details.fileName === undefined &&
    value.content.every((part) => record(part) && part.type === "text" && typeof part.text === "string")
  );
}

function resultText(result: { content: TextContent[] }): string {
  const text = result.content.map((part) => part.text).join("\n");
  if (Buffer.byteLength(text) > issuePilotConfig.limits.capability.resultBytes) throw new DomainError("agent_query_result_too_large", "payload_too_large");
  return text;
}

/** Project both SDK tool messages and application-only nested evidence through the same contract. */
export function savedQueryCompletion(sessionId: string, entry: SessionEntry): QueryCompletion | undefined {
  let completion: Completion;
  if (entry.type === "message" && entry.message.role === "toolResult") {
    const message = entry.message;
    if (message.toolName !== "service_query" || message.isError || !nativeResult(message)) return;
    completion = {
      type: "tool_execution_end",
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      isError: false,
      result: { content: message.content, details: message.details, ...(message.nestedCalls ? { nestedCalls: message.nestedCalls } : {}) },
      ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
    };
  } else if (entry.type === "custom" && entry.customType === customType) {
    const data = entry.data;
    if (!record(data) || typeof data.toolCallId !== "string" || typeof data.parentToolCallId !== "string" || !nativeResult(data.result)) return;
    completion = {
      type: "tool_execution_end",
      toolName: "service_query",
      toolCallId: data.toolCallId,
      parentToolCallId: data.parentToolCallId,
      isError: false,
      result: data.result,
      ...(typeof data.durationMs === "number" ? { durationMs: data.durationMs } : {}),
    };
  } else return;
  return { ...completion, result: { ...completion.result, queryResult: { sessionId, entryId: entry.id } } };
}

/** Called after mutable SDK hooks. Append once, before announcing availability or returning to the script. */
export function persistNestedQuery(manager: SessionManager, event: Completion): QueryCompletion | undefined {
  if (!event.parentToolCallId || event.toolName !== "service_query" || event.isError || !nativeResult(event.result)) return;
  const text = resultText(event.result);
  // Retain display provenance only, not arbitrary hook metadata or a duplicate structuredContent body.
  const details: Record<string, string> = {};
  for (const key of ["provider", "environment", "service", "schema", "instanceAlias"]) if (typeof event.result.details[key] === "string") details[key] = event.result.details[key];
  const id = manager.appendCustomEntry(customType, {
    toolCallId: event.toolCallId,
    parentToolCallId: event.parentToolCallId,
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    result: { content: [{ type: "text", text }], details },
  });
  return savedQueryCompletion(manager.getSessionId(), manager.getEntry(id)!);
}

/** SDK persists direct tool messages before turn_end. No duplicate entries or guessed call-ID lookup URLs. */
export function completedQueries(manager: SessionManager, event: Extract<JsonAgentSessionEvent, { type: "turn_end" }>): QueryCompletion[] {
  const calls = new Set(event.toolResults.filter((message) => message.toolName === "service_query" && !message.isError).map((message) => message.toolCallId));
  if (!calls.size) return [];
  const results: QueryCompletion[] = [];
  for (let entry = manager.getLeafEntry(); entry && calls.size; entry = entry.parentId ? manager.getEntry(entry.parentId) : undefined) {
    if (entry.type !== "message" || entry.message.role !== "toolResult" || !calls.delete(entry.message.toolCallId)) continue;
    const saved = savedQueryCompletion(manager.getSessionId(), entry);
    if (saved) results.unshift(saved);
  }
  return results;
}

/** The caller has already validated Issue/session ownership. Only the displayed branch is readable. */
export function readQueryResult(manager: SessionManager, entryId: string): string {
  const entry = manager.getBranch().find((candidate) => candidate.id === entryId);
  const saved = entry && savedQueryCompletion(manager.getSessionId(), entry);
  if (!saved || !nativeResult(saved.result)) throw new DomainError("agent_query_result_not_found", "not_found");
  return resultText(saved.result);
}
