import { eq } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { globalAgentConfiguration } from "../db/schema.ts";
import type { AgentConfiguration, AgentModelDefinition } from "../domain/contracts.ts";
import type { AgentModelCatalog } from "../pi/models.ts";

export async function loadGlobalAgentConfiguration(database: Pick<Database, "select">): Promise<AgentConfiguration> {
  const [configuration] = await database.select().from(globalAgentConfiguration).where(eq(globalAgentConfiguration.id, 1)).limit(1);
  if (!configuration) throw new Error("global_agent_configuration_missing");
  return { provider: configuration.provider, model: configuration.model, thinkingLevel: configuration.thinkingLevel as AgentConfiguration["thinkingLevel"] };
}

export function validateGlobalAgentConfiguration(configuration: AgentConfiguration, models: AgentModelDefinition[]): void {
  const model = models.find((candidate) => candidate.provider === configuration.provider && candidate.id === configuration.model);
  if (!model) throw new Error("agent_model_not_available");
  if (!model.thinkingLevels.includes(configuration.thinkingLevel)) throw new Error("agent_thinking_level_not_supported");
}

export async function ensureGlobalAgentConfiguration(database: Database, modelCatalog: AgentModelCatalog): Promise<void> {
  const [existing] = await database.select({ id: globalAgentConfiguration.id }).from(globalAgentConfiguration).where(eq(globalAgentConfiguration.id, 1)).limit(1);
  if (existing) return;
  const [model] = await modelCatalog.list();
  if (!model || !model.thinkingLevels.length) throw new Error("global_agent_model_unavailable");
  await database.insert(globalAgentConfiguration).values({
    id: 1,
    provider: model.provider,
    model: model.id,
    thinkingLevel: model.thinkingLevels.includes("medium") ? "medium" : model.thinkingLevels[0]!,
  });
}

export async function saveGlobalAgentConfiguration(database: Pick<Database, "update">, configuration: AgentConfiguration): Promise<void> {
  const [updated] = await database.update(globalAgentConfiguration).set({ ...configuration, updatedAt: new Date() }).where(eq(globalAgentConfiguration.id, 1)).returning({ id: globalAgentConfiguration.id });
  if (!updated) throw new Error("global_agent_configuration_missing");
}
