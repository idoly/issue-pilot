import { randomUUID } from "node:crypto";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { outputFileName } from "../outputs/store.ts";
import { localCommandExecutor, type CommandExecutor, type CommandExecutionResult } from "../process.ts";

const limits = issuePilotConfig.limits.sandbox;
const configuration = issuePilotConfig.runtime.sandbox;
const reservations = new Set<string>();
const pendingCleanup = new Map<string, PodmanSandbox>();

export interface AnalysisSandbox {
  readonly closed: boolean;
  execute(command: string, signal?: AbortSignal): Promise<CommandExecutionResult>;
  importFile(fileName: string, content: Uint8Array, signal?: AbortSignal): Promise<void>;
  exportFile(fileName: string, signal?: AbortSignal): Promise<Buffer>;
  close(): Promise<void>;
}
export type SandboxFactory = (signal?: AbortSignal) => Promise<AnalysisSandbox>;

// These programs receive file names as argv and bytes through stdin/stdout.
// They never interpret sandbox data as host code or host paths.
const importProgram = `
const fs = require('node:fs');
const content = fs.readFileSync(0);
if (content.length > Number(process.argv[2])) throw Error('sandbox_transfer_too_large');
fs.writeFileSync('/work/' + process.argv[1], content, {flag:'wx', mode:0o600});
`;
const exportProgram = `
const fs = require('node:fs');
const limit = Number(process.argv[2]);
const fd = fs.openSync('/work/' + process.argv[1], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
try {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.size > limit) throw Error('sandbox_export_invalid');
  const chunks = []; let size = 0;
  while (true) {
    const chunk = Buffer.alloc(Math.min(65536, limit - size + 1));
    const n = fs.readSync(fd, chunk);
    if (!n) break;
    size += n; if (size > limit) throw Error('sandbox_transfer_too_large');
    chunks.push(chunk.subarray(0,n));
  }
  process.stdout.write(Buffer.concat(chunks, size).toString('base64'));
} finally { fs.closeSync(fd); }
`;

export class PodmanSandbox implements AnalysisSandbox {
  readonly name = `issue-pilot-analysis-${randomUUID()}`;
  closed = false;
  private closing: Promise<void> | undefined;
  private readonly executor: CommandExecutor;
  private constructor(executor: CommandExecutor) { this.executor = executor; }

  static async open(signal?: AbortSignal, executor: CommandExecutor = localCommandExecutor): Promise<PodmanSandbox> {
    if (process.platform !== "linux" || !process.getuid || !process.getgid || process.getuid() === 0) throw new Error("sandbox_requires_rootless_linux");
    if (signal?.aborted) throw new Error("sandbox_aborted");
    await PodmanSandbox.cleanupPending();
    if (reservations.size >= limits.concurrency) throw new Error("sandbox_capacity_exceeded");
    const sandbox = new PodmanSandbox(executor);
    reservations.add(sandbox.name);
    try {
      const result = await executor.execute(configuration.executable, [
        "run", "--detach", "--rm", "--pull", "never", "--name", sandbox.name,
        "--label", "io.issue-pilot.component=analysis-sandbox",
        "--timeout", String(limits.lifetimeSeconds), "--stop-timeout", "0",
        "--network", "none", "--http-proxy=false", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--userns", "keep-id", "--user", `${process.getuid()}:${process.getgid()}`,
        "--memory", String(limits.memoryBytes), "--memory-swap", String(limits.memoryBytes),
        "--cpus", String(limits.cpus), "--pids-limit", String(limits.processes),
        "--env", "HOME=/tmp", "--env", "LANG=C.UTF-8",
        "--tmpfs", `/tmp:rw,nosuid,nodev,size=${limits.temporaryBytes}`,
        "--tmpfs", `/work:rw,nosuid,nodev,size=${limits.workspaceBytes},mode=1777`,
        "--workdir", "/work", configuration.image, "node", "-e", "setInterval(() => {}, 3600000)",
      ], { timeout: limits.controlMs, ...(signal ? { signal } : {}) });
      if (result.code || result.killed) throw new Error(signal?.aborted ? "sandbox_aborted" : "sandbox_unavailable");
      return sandbox;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        sandbox.closed = true; reservations.delete(sandbox.name);
      } else await sandbox.close();
      throw new Error(error instanceof Error && error.message === "sandbox_aborted" ? "sandbox_aborted" : "sandbox_unavailable");
    }
  }

  static async cleanupPending(): Promise<void> {
    const results = await Promise.allSettled([...pendingCleanup.values()].map(sandbox => sandbox.close()));
    if (results.some(result => result.status === "rejected")) throw new Error("sandbox_cleanup_failed");
  }

  execute(command: string, signal?: AbortSignal): Promise<CommandExecutionResult> {
    return this.run(["sh", "-lc", command], limits.outputBytes, signal);
  }

  async importFile(fileName: string, content: Uint8Array, signal?: AbortSignal): Promise<void> {
    const name = outputFileName(fileName);
    if (content.byteLength > limits.transferBytes) throw new Error("sandbox_transfer_too_large");
    const result = await this.run(["node", "-e", importProgram, "--", name, String(limits.transferBytes)], limits.outputBytes, signal, content);
    if (result.code) throw new Error("sandbox_import_failed_remove_existing_file_before_retry");
  }

  async exportFile(fileName: string, signal?: AbortSignal): Promise<Buffer> {
    const name = outputFileName(fileName);
    const result = await this.run(["node", "-e", exportProgram, "--", name, String(limits.transferBytes)], Math.ceil(limits.transferBytes / 3) * 4 + 1024, signal);
    if (result.code || result.stdout.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.stdout)) throw new Error("sandbox_export_failed_regular_work_file_required");
    const content = Buffer.from(result.stdout, "base64");
    if (content.length > limits.transferBytes) throw new Error("sandbox_transfer_too_large");
    return content;
  }

  private async run(args: string[], maximum: number, signal?: AbortSignal, input?: Uint8Array): Promise<CommandExecutionResult> {
    if (this.closed || this.closing) throw new Error("sandbox_closed");
    try {
      if (signal?.aborted) throw new Error("sandbox_aborted");
      const result = await this.executor.execute(configuration.executable, ["exec", ...(input ? ["--interactive"] : []), "--workdir", "/work", this.name, ...args], {
        timeout: limits.executionMs, maxOutputBytes: maximum, ...(signal ? { signal } : {}), ...(input ? { input } : {}),
      });
      if (result.killed) throw new Error(signal?.aborted ? "sandbox_aborted" : "sandbox_timeout");
      return result;
    } catch (error) {
      await this.close();
      if (error instanceof Error && error.message === "command_output_too_large") throw new Error("sandbox_output_too_large");
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing ??= (async () => {
      const result = await this.executor.execute(configuration.executable, ["rm", "--force", "--time", "0", "--ignore", this.name], { timeout: limits.controlMs });
      if (result.code || result.killed) throw new Error("sandbox_cleanup_failed");
      this.closed = true;
      reservations.delete(this.name);
      pendingCleanup.delete(this.name);
    })();
    try { await this.closing; } catch (error) { this.closing = undefined; pendingCleanup.set(this.name, this); throw error; }
  }
}
