import type { Usage } from "@earendil-works/pi-ai";

import { mergeAgentCostSource, type AgentFooterStats } from "../domain/contracts.ts";

type FooterUsage = Pick<AgentFooterStats, "input" | "output" | "cacheRead" | "cacheWrite" | "cost" | "costSource">;

/** Merge one usage record into cumulative footer stats. Server snapshots and live client events share this rule. */
export function mergeFooterUsage<Stats extends FooterUsage>(stats: Stats, usage: Usage): Stats {
  return {
    ...stats,
    input: stats.input + usage.input,
    output: stats.output + usage.output,
    cacheRead: stats.cacheRead + usage.cacheRead,
    cacheWrite: stats.cacheWrite + usage.cacheWrite,
    cost: stats.cost + usage.cost.total,
    costSource: mergeAgentCostSource(stats.costSource, usage.cost),
  };
}

/** Context size follows the SDK: prefer the provider total, otherwise sum all reported token classes. */
export function contextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** A failed, aborted or empty assistant request cannot replace the last context estimate. */
export function validAssistantUsage(message: { role: string; stopReason?: string; usage?: Usage }): message is { role: string; usage: Usage } {
  return message.role === "assistant" && message.stopReason !== "aborted" && message.stopReason !== "error" && Boolean(message.usage && contextTokens(message.usage) > 0);
}
