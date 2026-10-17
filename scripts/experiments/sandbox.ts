import { randomUUID } from "node:crypto";
import { executeLocalCommand } from "../../src/process.ts";

export const sandboxImage = "docker.io/library/node:26-bookworm-slim";
export const sandboxLimits = { memory: "512m", cpus: "1", pids: "64", temporary: "64m", workspace: "128m", executionMs: 30_000, outputBytes: 256 * 1024 } as const;

/** Experimental runner: accepts generated fixtures only, never application state or repository mounts. */
export class ExperimentSandbox {
  readonly name = `issue-pilot-experiment-${randomUUID()}`;
  private closed = false;
  private constructor() {}

  static async open(evidenceDirectory: string): Promise<ExperimentSandbox> {
    if (process.platform !== "linux" || !process.getuid || !process.getgid || process.getuid() === 0) throw new Error("rootless_linux_required");
    const sandbox = new ExperimentSandbox();
    const result = await executeLocalCommand("podman", [
      "run", "--detach", "--pull", "never", "--name", sandbox.name,
      "--label", "io.issue-pilot.component=sandbox-experiment", "--network", "none",
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--userns", "keep-id", "--user", `${process.getuid!()}:${process.getgid!()}`,
      "--memory", sandboxLimits.memory, "--memory-swap", sandboxLimits.memory,
      "--cpus", sandboxLimits.cpus, "--pids-limit", sandboxLimits.pids,
      "--env", "HOME=/tmp", "--env", "LANG=C.UTF-8",
      "--volume", `${evidenceDirectory}:/evidence:ro,Z`,
      "--tmpfs", `/tmp:rw,nosuid,nodev,size=${sandboxLimits.temporary}`,
      "--tmpfs", `/work:rw,nosuid,nodev,size=${sandboxLimits.workspace},mode=1777`,
      "--workdir", "/work", sandboxImage, "node", "-e", "setInterval(() => {}, 3600000)",
    ], { timeout: 20_000 });
    if (result.code || result.killed) {
      await sandbox.close();
      throw new Error(`sandbox_start_failed:${result.stderr.trim()}`);
    }
    return sandbox;
  }

  async execute(command: string, signal?: AbortSignal, timeout: number = sandboxLimits.executionMs) {
    if (this.closed) throw new Error("sandbox_closed");
    if (signal?.aborted) { await this.close(); throw new Error("sandbox_aborted"); }
    try {
      const result = await executeLocalCommand("podman", ["exec", "--workdir", "/work", this.name, "sh", "-lc", command], {
        timeout, maxOutputBytes: sandboxLimits.outputBytes, ...(signal ? { signal } : {}),
      });
      // Killing the exec client alone leaves container descendants alive.
      if (result.killed) { await this.close(); throw new Error(signal?.aborted ? "sandbox_aborted" : "sandbox_timeout"); }
      return result;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const result = await executeLocalCommand("podman", ["rm", "--force", "--time", "0", "--ignore", this.name], { timeout: 15_000 });
    if (result.code || result.killed) throw new Error("sandbox_cleanup_failed");
    this.closed = true;
  }
}
