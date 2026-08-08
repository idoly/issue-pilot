import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { AGENT_THINKING_LEVELS, type AgentThinkingLevel } from "../domain/contracts.ts";

export { AGENT_THINKING_LEVELS };
export type { AgentThinkingLevel };

export interface AgentModelDefinition {
  provider: string;
  id: string;
  name: string;
  api: string;
  thinkingLevels: AgentThinkingLevel[];
}

export interface AgentModelCatalog {
  list(): Promise<AgentModelDefinition[]>;
}

export class PiAgentModelCatalog implements AgentModelCatalog {
  private readonly runtime = ModelRuntime.create({ allowModelNetwork: false });
  private listing: Promise<AgentModelDefinition[]> | undefined;

  list(): Promise<AgentModelDefinition[]> {
    if (this.listing) return this.listing;
    this.listing = this.load().finally(() => { this.listing = undefined; });
    return this.listing;
  }

  private async load(): Promise<AgentModelDefinition[]> {
    const runtime = await this.runtime;
    await runtime.refresh();
    return runtime.getModels()
      .filter((model) => runtime.hasConfiguredAuth(model.provider))
      .map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        api: model.api,
        thinkingLevels: getSupportedThinkingLevels(model).filter((level): level is AgentThinkingLevel => AGENT_THINKING_LEVELS.includes(level as AgentThinkingLevel)),
      }))
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id));
  }
}
