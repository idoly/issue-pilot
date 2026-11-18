import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { issuePilotConfig } from "../../issue-pilot.config.ts";

const limits = issuePilotConfig.limits.capability;

/** Native evidence returned inline enters model context, so it uses the smaller inline budget and an actionable code. */
export function capabilityResultText(value: unknown, tooLargeCode: string): string {
  const text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text) > limits.inlineResultBytes) throw new Error(tooLargeCode);
  return text;
}

export function structuredJsonResult<Details>(result: AgentToolResult<Details>): AgentToolResult<Details> {
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  try {
    return { ...result, structuredContent: JSON.parse(text) };
  } catch {
    throw new Error("invalid_tool_json_result");
  }
}

export function capabilityTextResult<Details extends Record<string, unknown>>(text: string, details: Details) {
  return { content: [{ type: "text" as const, text }], details };
}
