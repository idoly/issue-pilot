import { issuePilotConfig } from "../../issue-pilot.config.ts";

const limits = issuePilotConfig.limits.capability;

export function capabilityResultText(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text) > limits.resultBytes) throw new Error("capability_result_too_large");
  return text;
}

export function capabilitySignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(limits.timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function capabilityTextResult<Details extends Record<string, unknown>>(text: string, details: Details) {
  return { content: [{ type: "text" as const, text }], details };
}
