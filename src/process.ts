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
    let failure: Error | undefined;
    let closed = false;
    let exitCode: number | null = null;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
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
    const groupAlive = () => {
      if (!usesProcessGroup || child.pid === undefined) return false;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    };
    const complete = () => {
      if (!closed || settled || escalation) return;
      finish(() => failure
        ? reject(failure)
        : resolve({ stdout, stderr, code: exitCode ?? 1, killed }));
    };
    const terminate = () => {
      if (killed) return;
      killed = true;
      signalProcess("SIGTERM");
      escalation = setTimeout(() => {
        escalation = undefined;
        signalProcess("SIGKILL");
        complete();
      }, issuePilotConfig.limits.process.terminationGraceMs);
    };
    const fail = (error: Error) => {
      failure ??= error;
      terminate();
    };
    const abort = () => terminate();
    const timer = options.timeout ? setTimeout(terminate, options.timeout) : undefined;
    timer?.unref();
    options.signal?.addEventListener("abort", abort, { once: true });
    const maximumOutputBytes = options.maxOutputBytes === undefined ? issuePilotConfig.limits.process.commandOutputBytes : options.maxOutputBytes;
    const capture = (append: (chunk: string) => void) => (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (maximumOutputBytes !== null && outputBytes > maximumOutputBytes) {
        fail(new Error("command_output_too_large"));
        return;
      }
      append(chunk);
    };
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") fail(error);
    });
    if (options.input) child.stdin?.end(options.input);
    child.stderr!.setEncoding("utf8");
    const captureStdout = capture((chunk) => {
      if (!options.onStdout) { stdout += chunk; return; }
      try { options.onStdout(chunk); }
      catch (error) { fail(error instanceof Error ? error : new Error("command_output_processing_failed")); }
    });
    if (options.strictStdoutUtf8) {
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      const decode = (chunk?: Buffer) => {
        if (failure || killed) return;
        let text: string;
        try { text = decoder.decode(chunk, { stream: chunk !== undefined }); }
        catch { fail(new Error("command_stdout_not_utf8")); return; }
        if (text) captureStdout(text);
      };
      child.stdout!.on("data", decode);
      child.stdout!.on("end", () => decode());
    } else {
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", captureStdout);
    }
    child.stderr!.on("data", capture((chunk) => { stderr += chunk; }));
    child.stdout!.on("error", fail);
    child.stderr!.on("error", fail);
    child.on("error", (error) => {
      failure ??= error;
      if (child.pid !== undefined) terminate();
    });
    child.on("close", (code) => {
      closed = true;
      exitCode = code;
      if (escalation && !groupAlive()) {
        clearTimeout(escalation);
        escalation = undefined;
      }
      complete();
    });
    if (options.signal?.aborted) terminate();
  });
}

export const localCommandExecutor: CommandExecutor = { execute: executeLocalCommand };
