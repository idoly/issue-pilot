import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { capabilityTextResult } from "../capabilities/contracts.ts";
import { IssueOutputStore, outputFileName } from "../outputs/store.ts";
import { SerialQueue } from "../serial.ts";
import { PodmanSandbox, type AnalysisSandbox, type SandboxFactory } from "../sandbox/runtime.ts";

/** Owns ephemeral analysis for one Pi session; every prompt ends its container. */
export class SandboxToolSession {
  private readonly queue = new SerialQueue();
  private current: AnalysisSandbox | undefined;
  private closed = false;
  private resetting = false;
  private readonly outputs: IssueOutputStore | undefined;
  private readonly factory: SandboxFactory;
  readonly tool;

  constructor(outputs?: IssueOutputStore, factory: SandboxFactory = (signal) => PodmanSandbox.open(signal)) {
    this.outputs = outputs;
    this.factory = factory;
    const run = Type.Object({ operation: Type.Literal("run"), command: Type.String({ minLength: 1, maxLength: issuePilotConfig.limits.sandbox.commandCharacters }) }, { additionalProperties: false });
    const reset = Type.Object({ operation: Type.Literal("reset") }, { additionalProperties: false });
    const transfer = Type.Object({ operation: Type.Union([Type.Literal("import_output"), Type.Literal("export_output")]), fileName: Type.String({ minLength: 1, maxLength: 255 }) }, { additionalProperties: false });
    const fullSchema = Type.Union([run, reset, transfer]);
    const schema = outputs ? fullSchema : Type.Union([run, reset]);
    this.tool = defineTool({
      name: "sandbox", label: "Isolated analysis", parameters: schema,
      description: `Run shell commands and Node.js in a private offline Linux container. /work and /tmp are writable; no host files, repositories, credentials, network, Python or package downloads are available. Files persist between calls in the current Agent run and are removed when it ends. Commands have ${issuePilotConfig.limits.sandbox.executionMs / 1000}s timeout. reset discards scratch state. ${outputs ? "import_output copies a named existing Issue output to /work/<fileName> without sending its contents to the model; export_output atomically publishes a regular /work/<fileName> to this Issue output store. Imports require a new file name (remove an existing scratch file explicitly before retrying)." : "Only temporary analysis is authorized; durable output import/export is unavailable."}`,
      promptGuidelines: ["Read small files directly. Use sandbox for bulk computation, joins, aggregation or temporary reproductions; return compact results.", "External resources are accessed through the existing authorized tools. Shell commands run offline. Scratch files are temporary; publish authorized deliverables before finishing."],
      execute: async (_id, raw, signal) => {
        let input: Static<typeof fullSchema>;
        try { input = Value.Parse(schema, raw); } catch { throw new Error("invalid_sandbox_input"); }
        return this.queue.run(async () => {
          this.assertRunning(signal);
          if (input.operation === "reset") {
            await this.current?.close(); this.current = undefined;
            return capabilityTextResult("Scratch state removed.", { operation: "reset" });
          }
          if (input.operation !== "run" && !this.outputs) throw new Error("sandbox_output_not_authorized");
          const name = input.operation === "run" ? undefined : outputFileName(input.fileName);
          // Validate/read in the host owner before allocating the container.
          const imported = input.operation === "import_output" ? await this.outputs!.read(name!, issuePilotConfig.limits.sandbox.transferBytes) : undefined;
          this.assertRunning(signal);
          if (!this.current || this.current.closed) {
            const created = await this.factory(signal);
            this.current = created;
            if (this.closed || this.resetting || signal?.aborted) { await created.close(); throw new Error("sandbox_aborted"); }
          }
          if (input.operation === "run") {
            const result = await this.current.execute(input.command, signal);
            return { content: [{ type: "text" as const, text: `Exit code: ${result.code}\n${result.stdout}${result.stderr ? `\nStderr:\n${result.stderr}` : ""}` }], details: { operation: "run", exitCode: result.code }, isError: result.code !== 0 };
          }
          if (input.operation === "import_output") {
            await this.current.importFile(name!, imported!, signal);
            return capabilityTextResult(JSON.stringify({ path: `/work/${name}`, size: imported!.length }), { operation: "import_output", fileName: name });
          }
          const content = await this.current.exportFile(name!, signal);
          this.assertRunning(signal);
          const output = await this.outputs!.generate(name!, async (append) => {
            this.assertRunning(signal); await append(content); this.assertRunning(signal);
          });
          return capabilityTextResult(JSON.stringify({ fileName: output.fileName, size: output.size }), { operation: "export_output", fileName: output.fileName, size: output.size });
        });
      },
    });
  }

  private assertRunning(signal?: AbortSignal) {
    if (this.closed || this.resetting || signal?.aborted) throw new Error("sandbox_aborted");
  }

  async finishRun(): Promise<void> {
    this.resetting = true;
    try {
      // Stop active exec before draining. A failed first removal gets one
      // retry after the queue settles, while the instance remains owned.
      try { await this.current?.close(); } catch { /* verified again below */ }
      await this.queue.idle();
      await this.current?.close();
      this.current = undefined;
    } finally { this.resetting = false; }
  }

  async close(): Promise<void> { this.closed = true; await this.finishRun(); }
}
