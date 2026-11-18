import { and, eq } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { globalAgentConfiguration } from "../db/schema.ts";
import { choice, text } from "../domain/input.ts";
import { AGENT_CODEMODE_MODES, AGENT_THINKING_LEVELS, type AgentConfiguration, type AgentModelDefinition, type AgentModelSelection, type PersonalModelCredentials } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
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

export interface ResolvedAgentModel {
  configuration: AgentConfiguration;
  apiKey: string;
}

/**
 * Select the configuration and its key together. A complete personal group owns both;
 * without one, the shared group and its key apply. Callers cannot pair one source's
 * selection with another source's key.
 */
export async function resolveAgentModel(database: Pick<Database, "select">, personal?: PersonalModelCredentials | null): Promise<ResolvedAgentModel> {
  const shared = await loadGlobalAgentConfiguration(database);
  if (personal) return { configuration: selectAgentConfiguration(shared, personal), apiKey: personal.apiKey };
  return { configuration: shared, apiKey: await loadSharedAgentApiKey(database) };
}

// The shared API key belongs to the global provider and is never part of the projected configuration.
export async function loadSharedAgentApiKey(database: Pick<Database, "select">): Promise<string> {
  const [configuration] = await database.select({ apiKey: globalAgentConfiguration.apiKey }).from(globalAgentConfiguration).where(eq(globalAgentConfiguration.id, 1)).limit(1);
  if (!configuration) throw new Error("global_agent_configuration_missing");
  return configuration.apiKey;
}

/** Shared and personal selections must both be offered by the current model catalog. */
export function parseAgentModelSelection(input: Record<string, unknown>, models: AgentModelDefinition[]): AgentModelSelection {
  const configuration = {
    provider: text(input.provider, "agent_provider", 200),
    model: text(input.model, "agent_model", 500),
    thinkingLevel: choice(input.thinkingLevel, "agent_thinking_level", AGENT_THINKING_LEVELS),
    codemode: choice(input.codemode, "agent_codemode", AGENT_CODEMODE_MODES),
  };
  const model = models.find((candidate) => candidate.provider === configuration.provider && candidate.id === configuration.model);
  if (!model) throw new DomainError("agent_model_not_available", "bad_request");
  if (!model.thinkingLevels.includes(configuration.thinkingLevel)) throw new DomainError("agent_thinking_level_not_supported", "bad_request");
  return configuration;
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

/** Shared model edits carry this revision; it advances with every saved change to the singleton. */
export async function loadGlobalAgentRevision(database: Pick<Database, "select">): Promise<number> {
  const [configuration] = await database.select({ revision: globalAgentConfiguration.revision }).from(globalAgentConfiguration).where(eq(globalAgentConfiguration.id, 1)).limit(1);
  if (!configuration) throw new Error("global_agent_configuration_missing");
  return configuration.revision;
}

/** Saves only over the expected revision and returns the next one; callers check it first, before disposing sessions. */
export async function saveGlobalAgentConfiguration(database: Pick<Database, "update">, configuration: AgentConfiguration, expectedRevision: number, apiKey?: string): Promise<number> {
  const [updated] = await database
    .update(globalAgentConfiguration)
    .set({ ...configuration, ...(apiKey === undefined ? {} : { apiKey }), revision: expectedRevision + 1, updatedAt: new Date() })
    .where(and(eq(globalAgentConfiguration.id, 1), eq(globalAgentConfiguration.revision, expectedRevision)))
    .returning({ revision: globalAgentConfiguration.revision });
  if (!updated) throw new DomainError("configuration_changed", "conflict");
  return updated.revision;
}
