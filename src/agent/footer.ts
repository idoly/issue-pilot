import type { Usage } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateTokens, type SessionManager } from "@earendil-works/pi-coding-agent";

import type { AgentFooterStats } from "../domain/contracts.ts";

function addUsage(stats: AgentFooterStats, usage: Usage): void {
  stats.input += usage.input;
  stats.output += usage.output;
  stats.cacheRead += usage.cacheRead;
  stats.cacheWrite += usage.cacheWrite;
  stats.cost += usage.cost.total;
}

function hasValidUsage(message: { role: string; stopReason?: string; usage?: Usage }): message is { role: string; usage: Usage } {
  return message.role === "assistant"
    && message.stopReason !== "aborted"
    && message.stopReason !== "error"
    && Boolean(message.usage && calculateContextTokens(message.usage) > 0);
}

export function sessionFooterStats(manager: SessionManager, contextWindow: number, autoCompact = true): AgentFooterStats {
  const stats: AgentFooterStats = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    latestCacheHitRate: null,
    contextPercent: null,
    contextWindow,
    autoCompact,
  };

  for (const entry of manager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      addUsage(stats, entry.message.usage);
      const promptTokens = entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
      stats.latestCacheHitRate = promptTokens > 0 ? (entry.message.usage.cacheRead / promptTokens) * 100 : null;
    } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
      addUsage(stats, entry.message.usage);
    } else if (entry.type === "usage") {
      addUsage(stats, entry.usage);
    } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      addUsage(stats, entry.usage);
    }
  }

  if (contextWindow <= 0) return stats;
  const branch = manager.getBranch();
  const compactionIndex = branch.findLastIndex((entry) => entry.type === "compaction");
  if (compactionIndex >= 0 && !branch.slice(compactionIndex + 1).some((entry) => entry.type === "message" && hasValidUsage(entry.message))) return stats;

  const messages = manager.buildSessionContext().messages;
  let lastUsageIndex = -1;
  let contextTokens = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (!hasValidUsage(message)) continue;
    lastUsageIndex = index;
    contextTokens = calculateContextTokens(message.usage);
    break;
  }
  const trailingStart = lastUsageIndex >= 0 ? lastUsageIndex + 1 : 0;
  for (let index = trailingStart; index < messages.length; index += 1) contextTokens += estimateTokens(messages[index]!);
  stats.contextPercent = (contextTokens / contextWindow) * 100;
  return stats;
}
