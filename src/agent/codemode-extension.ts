import { CODEMODE_OPTIONS_PREFIX, parseCodemodeSource } from "@earendil-works/pi-codemode";
import { createCodemodeExtension, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { generatedWorkFileSaver } from "../workspace/work-files.ts";

/**
 * Codemode scripts default to no deadline and share one process-wide worker pool, so a runaway script
 * (for example `while (true) {}`) would keep a worker until the round is cancelled. The model response
 * watchdog does not run during tool execution; this default bounds a script like the model idle budget.
 */
const codemodeScriptTimeoutMs = 5 * 60_000;

export function createIssueCodemodeExtension(root: string): ExtensionFactory {
  const base = createCodemodeExtension({ models: false, saveOutput: generatedWorkFileSaver(root, "codemode") });
  return async (pi) => {
    await base(pi);
    pi.on("tool_call", (event) => {
      if (event.toolName !== "codemode") return;
      const input = event.input as { code?: unknown };
      if (typeof input.code !== "string") return;
      // Use Pi's actual first-line grammar. Invalid inputs still get Pi's normal tool error.
      let parsed;
      try {
        parsed = parseCodemodeSource(input.code);
      } catch {
        return;
      }
      if (parsed.options.timeoutMs !== undefined) return;
      input.code = `${CODEMODE_OPTIONS_PREFIX} ${JSON.stringify({ timeout_ms: codemodeScriptTimeoutMs, max_output_tokens: parsed.options.maxOutputTokens })}\n${parsed.code}`;
    });
  };
}
