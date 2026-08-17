import { spawn } from "node:child_process";

import { issuePilotConfig } from "../issue-pilot.config.ts";

export interface CommandExecutionOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  environment?: Readonly<Record<string, string>>;
  maxOutputBytes?: number;
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
    const usesProcessGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.environment ? { env: { ...options.environment } } : {}),
      detached: usesProcessGroup,
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
    const signalProcess = (signal: NodeJS.Signals) => {
      if (!usesProcessGroup || child.pid === undefined) {
        child.kill(signal);
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
      }
    };
    const terminate = () => {
      if (killed) return;
      killed = true;
      signalProcess("SIGTERM");
      setTimeout(() => signalProcess("SIGKILL"), issuePilotConfig.limits.process.terminationGraceMs).unref();
    };
    const abort = () => terminate();
    const timer = options.timeout ? setTimeout(terminate, options.timeout) : undefined;
    timer?.unref();
    options.signal?.addEventListener("abort", abort, { once: true });
    const maximumOutputBytes = options.maxOutputBytes ?? issuePilotConfig.limits.process.commandOutputBytes;
    const capture = (append: (chunk: string) => void) => (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maximumOutputBytes) {
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
