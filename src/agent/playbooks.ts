import type { IssueWorkMode } from "../domain/contracts.ts";

/**
 * Method for each Issue work mode. The execution policy in prompts.ts owns permissions and boundaries;
 * this module owns how to investigate, diagnose and change code. Adding a work mode means adding one entry.
 */
const commonMethod = [
  "Problem-solving method:",
  "- Restate the problem first: expected behavior, observed behavior, the entry point that produces it (HTTP route, message consumer, scheduled job, UI action or tool command) and the evidence for each. If the report lacks one of these, state it as an assumption.",
  "- Trace a causal chain from that entry point to the symptom: handler or trigger → business logic → persistence or external call → returned result or side effect. Mark each link as verified in code (file:line) or only inferred.",
  "- Keep at least two plausible explanations open until evidence rules one out, and say which evidence would contradict the current one. Never present a guess as a confirmed cause.",
  "- When the cause is unclear or more than one file is involved, state a short plan before acting: step → the check that proves it. Revise the plan when evidence changes it.",
  "- Separate what you verified, what you inferred and what you could not check. Keep that distinction in the final answer.",
];

const impactChecklist = [
  "Change impact checklist (walk it before reporting a code change):",
  "- Callers: search every changed or renamed function, symbol and signature; update or explain each caller.",
  "- Contracts: request and response shapes, serialized fields, database columns and migrations, configuration keys and defaults, Agent prompts, tool schemas and MCP tools.",
  "- Failure paths: error codes and their mapping, timeouts, cancellation, retries, partial writes, rollback and cleanup.",
  "- Concurrency: per-entity serialization, shared caches and state that another operation can change while you work.",
  "- Consumers: Web views and state, Agent context, scheduled maintenance and other services reading the changed data.",
  "- Tests and documentation that describe the old behavior.",
];

const analysis = [
  "Investigation method:",
  "- Answer with the verified explanation, the evidence chain (code locations and business evidence with source and time), the affected scope (behaviors, services or data that inherit the problem), the remaining uncertainty and the next check that would resolve it.",
  "- Explain code behavior from the code. Use logs, traces and query rows to confirm what actually happened, not to infer what the code does; both together raise confidence.",
  "- When describing the affected scope, name the callers, contracts and consumers that inherit the behavior, and label each as verified or inferred.",
  "- This Issue is read-only for code and data. If a fix is requested, describe the minimal change, its risks and the checks that should accompany it, then stop.",
];

const defectFix = [
  "Defect fix method:",
  "- Establish the failure before editing: state why the current behavior is wrong using the reported steps, logs, traces or query rows. If the failure cannot be confirmed from available evidence, say so and lower the claimed confidence.",
  "- The root cause must explain every observed symptom. A change that hides the symptom without explaining it is a mitigation, and must be reported as one.",
  "- Know the full call chain you are changing: find the callers of the faulty function and the paths that reach it, and confirm the corrected behavior still holds for each. A fix at the symptom site when the cause is upstream is incomplete.",
  ...impactChecklist,
  "- Make the smallest change that fixes the cause. If the minimal change cannot fix it safely, explain what larger change is required instead of expanding scope silently.",
  "- After editing, re-read the whole diff, walk the changed chain again and update the tests and documentation the change invalidates.",
];

const featureDevelopment = [
  "Feature development method:",
  "- Turn the request into a behavior contract before coding: inputs and validation, outputs, error codes and messages, permission and role rules, configuration and defaults, empty and partial states, failure and cancellation behavior, and how the result is observed (API, Web, Agent prompt or tool).",
  "- Find the existing pattern that solves a neighboring problem and extend it; name the pattern (file and function) in your plan. Do not add a parallel mechanism for the same job.",
  "- List the layers the behavior crosses and check each one explicitly: schema and migration, configuration and defaults, domain rules, route or handler, persistence, background or Agent consumption, Web state and display, tests and documentation. Skip a layer only when you can say why it does not apply.",
  "- Treat failure, concurrency, permissions and existing records as part of the feature, not as follow-up work.",
  ...impactChecklist,
  "- Verify the completed behavior for the layers you actually changed, end to end where the environment allows it, and report what you could not verify.",
];

const fallback = [
  "This Issue combines an environment and type without a mapped work mode. It is read-only outside the explicitly available tools; investigate, state evidence, and do not modify code or data.",
];

export function workModePlaybook(workMode: IssueWorkMode | undefined): string[] {
  const mode =
    workMode === "development_fix"
      ? defectFix
      : workMode === "development_feature"
        ? featureDevelopment
        : workMode === "production_analysis" || workMode === "test_analysis"
          ? analysis
          : fallback;
  return [...commonMethod, "", ...mode];
}
