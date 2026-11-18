import { validateAgentModelSelection } from "../configuration/agent.ts";
import { isClassifiedOwnerFailure } from "../diagnostics.ts";
import { AGENT_CODEMODE_MODES, AGENT_THINKING_LEVELS, type AgentModelDefinition, type AgentModelSelection } from "../domain/contracts.ts";
import { choice, text } from "../domain/input.ts";

export { checkRevision, choice, closedRecord, optionalText, record, strings, text } from "../domain/input.ts";

/**
 * True when the global error handler already publishes this failure's category, outcome or operational code.
 * A route that names its own fallback for unexpected failures must not rename these.
 */
export function isClassifiedFailure(error: unknown): boolean {
  return isClassifiedOwnerFailure(error);
}

// Shared and personal model groups accept only provider/model/thinking combinations offered by the model catalog.
export function agentModelSelection(input: Record<string, unknown>, models: AgentModelDefinition[]): AgentModelSelection {
  const selection = {
    provider: text(input.provider, "agent_provider", 200),
    model: text(input.model, "agent_model", 500),
    thinkingLevel: choice(input.thinkingLevel, "agent_thinking_level", AGENT_THINKING_LEVELS),
    codemode: choice(input.codemode, "agent_codemode", AGENT_CODEMODE_MODES),
  };
  validateAgentModelSelection(selection, models);
  return selection;
}
