import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { RunEvent } from "./events.ts";

type ToolDisplayResult = { content: Array<TextContent | ImageContent>; displayTruncated?: boolean };

export function boundedText(value: string, maximumCharacters: number): string {
  if (value.length <= maximumCharacters) return value;
  const marker = "\n…（显示已截断，保留开头和结尾）…\n";
  const visibleCharacters = maximumCharacters - marker.length;
  const leadingCharacters = Math.ceil(visibleCharacters / 2);
  return `${value.slice(0, leadingCharacters)}${marker}${value.slice(value.length - (visibleCharacters - leadingCharacters))}`;
}

// A display projection only: never modify the result retained by Pi or the event bus.
export function displayToolResult<T extends ToolDisplayResult>(result: T): T {
  // SDK partial results are untyped and may be absent before a tool has output.
  if (!result || !Array.isArray(result.content)) return result;
  const text = result.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const images = result.content.filter((part): part is ImageContent => part.type === "image");
  const displayedText = boundedText(text, issuePilotConfig.web.agentToolOutputCharacters);
  return {
    ...result,
    ...(text.length > issuePilotConfig.web.agentToolOutputCharacters ? { displayTruncated: true } : {}),
    content: [...(displayedText ? [{ type: "text" as const, text: displayedText }] : []), ...images],
  };
}

export function agentDisplayEvent(envelope: RunEvent): RunEvent {
  const event = envelope.event;
  if (event.type === "tool_execution_end") return { ...envelope, event: { ...event, result: displayToolResult(event.result) } };
  if (event.type === "tool_execution_update") return { ...envelope, event: { ...event, partialResult: displayToolResult(event.partialResult) } };
  if (event.type === "message_end" && event.message.role === "toolResult") return { ...envelope, event: { ...event, message: displayToolResult(event.message) } };
  return envelope;
}
