import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, defineTool, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createPiModelRuntime } from "../../src/pi/models.ts";
import { ExperimentSandbox } from "./sandbox.ts";
import { createEvidence, type ExperimentTask } from "./tasks.ts";
import { benchmarkSandbox, verifySandbox } from "./checks.ts";

const args = process.argv.slice(2);
function option(name: string) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
const modelChoice = option("--model");
const trials = Number(option("--trials") ?? 3);
const selectedTasks = option("--tasks")?.split(",");
assert.ok(Number.isInteger(trials) && trials >= 1 && trials <= 10, "trials must be 1..10");
for (let i = 0; i < args.length; i += 2) assert.ok(["--model", "--trials", "--tasks"].includes(args[i]!) && args[i + 1], "Usage: npm run experiment:sandbox -- [--model provider/model] [--trials 3] [--tasks id,id]");
const root = await mkdtemp(join(tmpdir(), "issue-pilot-ablation-"));
const reportRoot = await mkdtemp(join(tmpdir(), "issue-pilot-ablation-report-"));
const evidence = join(root, "evidence");
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), reportRoot, fixture: "synthetic-v1", trials, model: modelChoice ?? null, results: [] };
const results = report.results as Record<string, unknown>[];
const save = async () => {
  const file = join(reportRoot, "results.json");
  await writeFile(`${file}.tmp`, JSON.stringify(report, null, 2), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
};
const modelRuntime = createPiModelRuntime();
let activeSandbox: ExperimentSandbox | undefined;
let activeSession: AgentSession | undefined;
let stop = false;
const interrupt = () => { stop = true; void activeSession?.abort().catch(() => undefined); void activeSandbox?.close().catch(() => undefined); };
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
console.log(`Report: ${join(reportRoot, "results.json")}`);
try {
  const tasks = await createEvidence(evidence);
  const fingerprint = createHash("sha256");
  for (const name of (await readdir(evidence)).sort()) fingerprint.update(name).update("\0").update(await readFile(join(evidence, name))).update("\0");
  report.evidenceSha256 = fingerprint.digest("hex");
  report.conditions = { thinkingLevel: "medium", modelRunTimeoutMs: 180_000, assistantTurns: 12, readAndShellCalls: 30, readPageCharacters: 50 * 1024, retry: false, compaction: false };
  if (selectedTasks) assert.ok(selectedTasks.every(id => tasks.some(task => task.id === id)), "unknown task ID");
  const chosen = tasks.filter(task => !selectedTasks || selectedTasks.includes(task.id));
  console.log("Checking container isolation, cancellation, timeout and output limits...");
  report.safetyChecks = await verifySandbox(evidence, root);
  console.log("Benchmarking fixed host/container executions...");
  report.benchmark = await benchmarkSandbox(evidence);
  await save();
  if (modelChoice) {
    const slash = modelChoice.indexOf("/");
    assert.ok(slash > 0, "model must be provider/model");
    const provider = modelChoice.slice(0, slash), modelId = modelChoice.slice(slash + 1);
    const models = await modelRuntime.load();
    await models.refresh({ providers: [provider], allowNetwork: false });
    const model = models.getModel(provider, modelId);
    assert.ok(model && models.getAvailableSnapshot().some(candidate => candidate.provider === provider && candidate.id === modelId), "requested model unavailable");
    const groups = ["A", "B", "C"] as const;
    for (let trial = 0; trial < trials; trial++) {
      for (const task of chosen) {
        // Rotate execution order to reduce systematic cache/load bias.
        for (let index = 0; index < groups.length; index++) {
          if (stop) throw new Error("experiment_interrupted");
          const group = groups[(index + trial) % groups.length]!;
          console.log(`Trial ${trial + 1}/${trials} ${task.id} ${group}`);
          results.push(await runTask(task, trial + 1, group));
          await save();
        }
      }
    }
    async function runTask(task: ExperimentTask, trial: number, group: "A" | "B" | "C") {
      const started = performance.now();
      let shellMs = 0, shellCalls = 0, readCalls = 0, modelTurns = 0, codemodeCalls = 0, failedToolCalls = 0;
      let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
      const sandbox = group === "A" ? undefined : await ExperimentSandbox.open(evidence);
      activeSandbox = sandbox;
      const startupMs = performance.now() - started;
      const read = defineTool({ name: "read", label: "Read evidence", description: "Read a synthetic evidence file from /evidence. Offset is zero-based characters; at most 51200 characters per call. Continue with nextOffset when provided.", parameters: Type.Object({ file: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }), execute: async (_id, args) => {
        if (++readCalls + shellCalls > 30) throw new Error("experiment_tool_budget_exceeded");
        const file = args.file.replace(/^\/evidence\//, "");
        if (!/^[a-zA-Z0-9_.-]+$/.test(file) || file === "." || file === "..") throw new Error("evidence_path_invalid");
        const text = await readFile(join(evidence, file), "utf8");
        const offset = args.offset ?? 0, content = text.slice(offset, offset + 50 * 1024);
        return { content: [{ type: "text", text: JSON.stringify({ content, nextOffset: offset + content.length < text.length ? offset + content.length : null }) }], details: undefined };
      } });
      const shell = defineTool({ name: "shell", label: "Sandbox shell", description: "Run any shell command inside the isolated offline container. Node.js and standard Unix tools are available. /evidence is read-only; /work and /tmp are writable. No network or Python/package installation in this first experiment. Return compact results for large datasets.", parameters: Type.Object({ command: Type.String({ maxLength: 20000 }) }, { additionalProperties: false }), execute: async (_id, args, signal) => {
        if (++shellCalls + readCalls > 30) throw new Error("experiment_tool_budget_exceeded");
        const start = performance.now();
        try {
          const result = await sandbox!.execute(args.command, signal);
          if (result.code) throw new Error(`shell_exit_${result.code}: ${result.stderr}`);
          return { content: [{ type: "text", text: result.stdout }], details: undefined };
        } finally { shellMs += performance.now() - start; }
      } });
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, "empty-agent"), settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: group === "C" ? [createCodemodeExtension({ mode: "on", models: false })] : [], systemPrompt: "Complete the offline evidence task accurately using available tools. Do not ask for help. Evidence is synthetic. Final answer must be one JSON object, with no prose or markdown." });
      await resourceLoader.reload();
      const { session } = await createAgentSession({ cwd: root, modelRuntime: models, model: model!, thinkingLevel: "medium", tools: ["read", ...(sandbox ? ["shell"] : []), ...(group === "C" ? ["codemode"] : [])], customTools: [read, ...(sandbox ? [shell] : [])], sessionManager: SessionManager.inMemory(), settingsManager, resourceLoader });
      activeSession = session;
      let failure: string | undefined;
      let finalText: string | undefined;
      const toolErrors: Array<{ tool: string; message: string }> = [];
      const unsubscribe = session.subscribe(event => {
        if (event.type === "tool_execution_start" && event.toolName === "codemode") codemodeCalls++;
        if (event.type === "tool_execution_end" && event.isError) {
          failedToolCalls++;
          toolErrors.push({ tool: event.toolName, message: (event.result.content as Array<{ type: string; text?: string }>).filter(block => block.type === "text").map(block => block.text ?? "").join("\n").slice(0, 2000) });
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          modelTurns++;
          const usage = event.message.usage;
          input += usage.input; output += usage.output; cacheRead += usage.cacheRead; cacheWrite += usage.cacheWrite; cost += usage.cost.total;
          if (modelTurns >= 12 || readCalls + shellCalls > 30) { failure = "experiment_budget_exceeded"; void session.abort().catch(() => undefined); }
        }
      });
      const timer = setTimeout(() => { failure = "experiment_run_timeout"; void session.abort().catch(() => undefined); }, 180_000);
      let actual: unknown = null;
      try {
        if (stop) throw new Error("experiment_interrupted");
        await session.bindExtensions({});
        await session.prompt(task.prompt);
        finalText = session.getLastAssistantText();
        try { actual = JSON.parse(finalText ?? ""); } catch { failure ??= "invalid_final_json"; }
        const errors = session.messages.filter(message => message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"));
        if (errors.length) failure ??= "model_error_or_aborted";
      } catch { failure ??= "session_execution_failed"; }
      finally { clearTimeout(timer); unsubscribe(); session.dispose(); activeSession = undefined; await sandbox?.close(); activeSandbox = undefined; }
      let passed = false;
      try { assert.deepEqual(actual, task.expected); passed = !failure; } catch {}
      return { task: task.id, trial, group, passed, failure: failure ?? (passed ? null : "answer_mismatch"), diagnostics: { toolErrors, ...(!passed ? { finalText: finalText?.slice(0, 2000) ?? null } : {}) }, actual, expected: task.expected, wallMs: performance.now() - started, startupMs, shellMs, shellCalls, readCalls, codemodeCalls, failedToolCalls, modelTurns, tokens: { input, output, cacheRead, cacheWrite }, cost, manualInterventions: 0 };
    }
  } else report.modelExperiment = "not_run: supply --model provider/model; safety and fixed-program benchmark only";
  report.summary = ["A", "B", "C"].map(group => {
    const rows = results.filter(row => row.group === group);
    const mean = (field: string) => rows.length ? rows.reduce((sum, row) => sum + Number(row[field]), 0) / rows.length : null;
    return { group, runs: rows.length, passed: rows.filter(row => row.passed).length, meanWallMs: mean("wallMs"), meanModelTurns: mean("modelTurns"), meanCodemodeCalls: mean("codemodeCalls"), meanCost: mean("cost") };
  });
  report.completedAt = new Date().toISOString();
  console.log(JSON.stringify({ safetyChecks: (report.safetyChecks as string[]).length, benchmark: report.benchmark, modelRuns: results.length, passed: results.filter(row => row.passed).length }, null, 2));
} catch (error) {
  report.failure = error instanceof Error ? error.message : "experiment_failed";
  process.exitCode = 1;
  console.error(report.failure);
} finally {
  const cleanupErrors: string[] = [];
  try { await activeSandbox?.close(); } catch { cleanupErrors.push("sandbox_cleanup_failed"); }
  try { await modelRuntime.close(); } catch { cleanupErrors.push("model_runtime_cleanup_failed"); }
  process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  if (!cleanupErrors.length) {
    try { await rm(root, { recursive: true, force: true }); } catch { cleanupErrors.push("fixture_cleanup_failed"); }
  }
  if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; report.preservedExperimentRoot = root; process.exitCode = 1; }
  await save();
}
