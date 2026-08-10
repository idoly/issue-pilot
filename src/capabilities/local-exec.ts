import { spawn } from "node:child_process";

import { issuePilotConfig } from "../../issue-pilot.config.ts";

export interface CommandExecutionOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  environment?: Readonly<Record<string, string>>;
}

export interface CommandExecutionResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface CommandExecutor {
  execute(command: string, args: string[], options?: CommandExecutionOptions): Promise<CommandExecutionResult>;
}

export async function executeLocalCommand(command: string, args: string[], options: CommandExecutionOptions = {}): Promise<CommandExecutionResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.environment ? { env: { ...options.environment } } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    let outputBytes = 0;
    let outputLimitExceeded = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      operation();
    };
    const terminate = () => {
      if (killed) return;
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), issuePilotConfig.limits.process.terminationGraceMs).unref();
    };
    const abort = () => terminate();
    const timer = options.timeout ? setTimeout(terminate, options.timeout) : undefined;
    timer?.unref();
    options.signal?.addEventListener("abort", abort, { once: true });
    const capture = (append: (chunk: string) => void) => (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > issuePilotConfig.limits.process.commandOutputBytes) {
        outputLimitExceeded = true;
        terminate();
        return;
      }
      append(chunk);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", capture((chunk) => { stdout += chunk; }));
    child.stderr.on("data", capture((chunk) => { stderr += chunk; }));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => outputLimitExceeded
      ? reject(new Error("command_output_too_large"))
      : resolve({ stdout, stderr, code: code ?? 1, killed })));
    if (options.signal?.aborted) terminate();
  });
}

export const localCommandExecutor: CommandExecutor = { execute: executeLocalCommand };
