import { spawn } from "node:child_process";

import { issuePilotConfig } from "../issue-pilot.config.ts";

export interface CommandExecutionOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  environment?: Readonly<Record<string, string>>;
  maxOutputBytes?: number | null;
  input?: Uint8Array;
  /** Reject malformed stdout instead of replacing invalid UTF-8 bytes. */
  strictStdoutUtf8?: boolean;
  /** Consume stdout as it arrives instead of retaining it in the result. */
  onStdout?: (chunk: string) => void;
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
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const usesProcessGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.environment ? { env: { ...options.environment } } : {}),
      detached: usesProcessGroup,
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    let outputBytes = 0;
    let outputLimitExceeded = false;
    let streamError: Error | undefined;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      operation();
    };
    const signalProcess = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      if (!usesProcessGroup) {
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
    const maximumOutputBytes = options.maxOutputBytes === undefined ? issuePilotConfig.limits.process.commandOutputBytes : options.maxOutputBytes;
    const capture = (append: (chunk: string) => void) => (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (maximumOutputBytes !== null && outputBytes > maximumOutputBytes) {
        outputLimitExceeded = true;
        terminate();
        return;
      }
      append(chunk);
    };
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") terminate();
    });
    if (options.input) child.stdin?.end(options.input);
    child.stderr!.setEncoding("utf8");
    const captureStdout = capture((chunk) => {
      if (!options.onStdout) { stdout += chunk; return; }
      try { options.onStdout(chunk); }
      catch (error) { streamError = error instanceof Error ? error : new Error("command_output_processing_failed"); terminate(); }
    });
    if (options.strictStdoutUtf8) {
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      const decode = (chunk?: Buffer) => {
        if (streamError || killed) return;
        let text: string;
        try { text = decoder.decode(chunk, { stream: chunk !== undefined }); }
        catch { streamError = new Error("command_stdout_not_utf8"); terminate(); return; }
        if (text) captureStdout(text);
      };
      child.stdout!.on("data", decode);
      child.stdout!.on("end", () => decode());
    } else {
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", captureStdout);
    }
    child.stderr!.on("data", capture((chunk) => { stderr += chunk; }));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => streamError
      ? reject(streamError)
      : outputLimitExceeded
        ? reject(new Error("command_output_too_large"))
        : resolve({ stdout, stderr, code: code ?? 1, killed })));
    if (options.signal?.aborted) terminate();
  });
}

export const localCommandExecutor: CommandExecutor = { execute: executeLocalCommand };
