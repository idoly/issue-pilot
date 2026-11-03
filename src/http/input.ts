import { validateAgentModelSelection } from "../configuration/agent.ts";
import { AGENT_CODEMODE_MODES, AGENT_THINKING_LEVELS, type AgentModelDefinition, type AgentModelSelection } from "../domain/contracts.ts";

export class ApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function checkRevision(value: unknown, actual: number): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ApiError(400, "invalid_configuration_revision");
  if (value !== actual) throw new ApiError(409, "configuration_changed");
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "invalid_request");
  return value as Record<string, unknown>;
}

export function text(value: unknown, name: string, maximum = 10_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new ApiError(400, `invalid_${name}`);
  return value.trim();
}

export function optionalText(value: unknown, maximum = 10_000): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > maximum) throw new ApiError(400, "invalid_text");
  return value.trim() || null;
}

export function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) throw new ApiError(400, `invalid_${name}`);
  return value as string[];
}

export function choice<const Values extends readonly string[]>(value: unknown, name: string, values: Values): Values[number] {
  const selected = text(value, name, 100);
  if (!values.includes(selected)) throw new ApiError(400, `invalid_${name}`);
  return selected as Values[number];
}

// Shared and personal model groups accept only provider/model/thinking combinations offered by the model catalog.
export function agentModelSelection(input: Record<string, unknown>, models: AgentModelDefinition[]): AgentModelSelection {
  const selection = {
    provider: text(input.provider, "agent_provider", 200),
    model: text(input.model, "agent_model", 500),
    thinkingLevel: choice(input.thinkingLevel, "agent_thinking_level", AGENT_THINKING_LEVELS),
    codemode: choice(input.codemode, "agent_codemode", AGENT_CODEMODE_MODES),
  };
  try {
    validateAgentModelSelection(selection, models);
  } catch (error) {
    if (error instanceof Error && ["agent_model_not_available", "agent_thinking_level_not_supported"].includes(error.message)) throw new ApiError(400, error.message);
    throw error;
  }
  return selection;
}
