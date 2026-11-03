import { eq } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { globalAgentConfiguration } from "../db/schema.ts";
import type { AgentConfiguration, AgentModelDefinition, AgentModelSelection } from "../domain/contracts.ts";
import type { AgentModelCatalog } from "../agent/model-runtime.ts";

export async function loadGlobalAgentConfiguration(database: Pick<Database, "select">): Promise<AgentConfiguration> {
  const [configuration] = await database.select().from(globalAgentConfiguration).where(eq(globalAgentConfiguration.id, 1)).limit(1);
  if (!configuration) throw new Error("global_agent_configuration_missing");
  return {
    provider: configuration.provider,
    model: configuration.model,
    thinkingLevel: configuration.thinkingLevel as AgentConfiguration["thinkingLevel"],
    codemode: configuration.codemode,
    runtime: configuration.runtime,
  };
}

/** Personal model fields replace the shared selection without projecting its API key. */
export function selectAgentConfiguration(shared: AgentConfiguration, personal?: AgentModelSelection | null): AgentConfiguration {
  return personal ? { ...shared, provider: personal.provider, model: personal.model, thinkingLevel: personal.thinkingLevel, codemode: personal.codemode } : shared;
}

// The shared API key belongs to the global provider and is never part of the projected configuration.
export async function loadSharedAgentApiKey(database: Pick<Database, "select">): Promise<string> {
  const [configuration] = await database.select({ apiKey: globalAgentConfiguration.apiKey }).from(globalAgentConfiguration).where(eq(globalAgentConfiguration.id, 1)).limit(1);
  if (!configuration) throw new Error("global_agent_configuration_missing");
  return configuration.apiKey;
}

export function validateAgentModelSelection(configuration: AgentModelSelection, models: AgentModelDefinition[]): void {
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
    codemode: "on",
    runtime: {},
    id: 1,
    provider: model.provider,
    model: model.id,
    thinkingLevel: model.thinkingLevels.includes("medium") ? "medium" : model.thinkingLevels[0]!,
  });
}

export async function saveGlobalAgentConfiguration(database: Pick<Database, "update">, configuration: AgentConfiguration, apiKey?: string): Promise<void> {
  const [updated] = await database
    .update(globalAgentConfiguration)
    .set({ ...configuration, ...(apiKey === undefined ? {} : { apiKey }), updatedAt: new Date() })
    .where(eq(globalAgentConfiguration.id, 1))
    .returning({ id: globalAgentConfiguration.id });
  if (!updated) throw new Error("global_agent_configuration_missing");
}
