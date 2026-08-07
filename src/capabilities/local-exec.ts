import { spawn } from "node:child_process";

export interface CommandOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface CommandExecutor {
  exec(command: string, args: string[], options?: CommandOptions): Promise<CommandResult>;
}

export async function execLocal(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      operation();
    };
    const terminate = () => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    };
    const abort = () => terminate();
    const timer = options.timeout ? setTimeout(terminate, options.timeout) : undefined;
    timer?.unref();
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => resolve({ stdout, stderr, code: code ?? 1, killed })));
    if (options.signal?.aborted) terminate();
  });
}

export const localExecutor: CommandExecutor = { exec: execLocal };
