import { mkdir, stat, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { spawn as spawnPty, type IPty } from "node-pty";

export interface PtyBinding {
  issueId: string;
  issueKey: string;
  sessionFile: string;
  workspacePath: string;
}

export interface PtyClient {
  output(data: string): void;
  exit(exitCode: number): void;
}

export interface PtyAttachment {
  input(data: string): void;
  resize(cols: number, rows: number): void;
  detach(): void;
}

interface ManagedPty {
  binding: PtyBinding;
  terminal: IPty;
  client: PtyClient | null;
  backlog: string;
  idleTimer: NodeJS.Timeout | null;
  retained: boolean;
  signalFile: string | null;
  exit: Promise<number>;
}

export interface PtyRunOptions {
  prompt: string;
  provider: string;
  model: string;
  thinking: string;
}

export class PtySessions {
  private readonly sessions = new Map<string, ManagedPty>();
  private readonly piExecutable: string;
  private readonly extensionPath: string | null;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly signalDirectory: string;
  private readonly idleTimeoutMs: number;

  constructor(piExecutable: string, extensionPath: string | null, environment: NodeJS.ProcessEnv, signalDirectory: string, idleTimeoutMs = 30 * 60_000) {
    this.piExecutable = piExecutable;
    this.extensionPath = extensionPath;
    this.environment = environment;
    this.signalDirectory = signalDirectory;
    this.idleTimeoutMs = idleTimeoutMs;
  }

  isAttached(issueId: string): boolean {
    return Boolean(this.sessions.get(issueId)?.client);
  }

  has(issueId: string): boolean {
    return this.sessions.has(issueId);
  }

  sendPrompt(issueId: string, message: string): boolean {
    const managed = this.sessions.get(issueId);
    if (!managed) return false;
    managed.terminal.write(`\x1b[200~${message.replace(/\x1b/g, "")}\x1b[201~\r`);
    return true;
  }

  abort(issueId: string): boolean {
    const managed = this.sessions.get(issueId);
    if (!managed) return false;
    managed.terminal.write("\x1b");
    return true;
  }

  async execute(binding: PtyBinding, options: PtyRunOptions): Promise<void> {
    let managed = this.sessions.get(binding.issueId);
    if (managed && (managed.binding.sessionFile !== binding.sessionFile || managed.binding.workspacePath !== binding.workspacePath)) {
      if (managed.client) throw new Error("pi_terminal_already_open");
      this.stop(managed);
      managed = undefined;
    }

    let baseline = 0;
    if (managed) {
      if (!managed.signalFile) throw new Error("pi_terminal_not_runner_owned");
      baseline = await stat(managed.signalFile).then((value) => value.size, () => 0);
      managed.retained = true;
      if (managed.idleTimer) clearTimeout(managed.idleTimer);
      managed.idleTimer = null;
      this.sendPrompt(binding.issueId, options.prompt);
    } else {
      await mkdir(this.signalDirectory, { recursive: true, mode: 0o700 });
      const signalFile = path.join(this.signalDirectory, `${binding.issueKey.toLowerCase()}.settled`);
      await writeFile(signalFile, "", { mode: 0o600 });
      const args = [
        "--session", binding.sessionFile,
        "-a",
        "--provider", options.provider,
        "--model", options.model,
        "--thinking", options.thinking,
      ];
      if (this.extensionPath) args.push("-e", this.extensionPath);
      args.push(options.prompt);
      managed = this.create(binding, 100, 30, args, {
        ...this.environment,
        ISSUE_PILOT_SETTLED_SIGNAL_FILE: signalFile,
      }, true, signalFile);
    }

    await this.waitForSettlement(managed, baseline);
    managed.retained = false;
    if (!managed.client) this.scheduleIdleStop(managed);
  }

  async releaseDetached(issueId: string): Promise<boolean> {
    const managed = this.sessions.get(issueId);
    if (!managed) return true;
    if (managed.client) return false;
    const exited = new Promise<void>((resolve) => { managed.terminal.onExit(() => resolve()); });
    this.stop(managed);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), 5_000); }),
    ]);
    if (timer) clearTimeout(timer);
    return !timedOut;
  }

  attach(binding: PtyBinding, client: PtyClient, cols: number, rows: number): PtyAttachment {
    let managed = this.sessions.get(binding.issueId);
    if (managed && (managed.binding.sessionFile !== binding.sessionFile || managed.binding.workspacePath !== binding.workspacePath)) {
      if (managed.client) throw new Error("pi_terminal_already_open");
      this.stop(managed);
      managed = undefined;
    }
    if (managed?.client) throw new Error("pi_terminal_already_open");
    managed ??= this.create(binding, cols, rows);
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    managed.idleTimer = null;
    managed.client = client;
    if (managed.backlog) client.output(managed.backlog);
    try { managed.terminal.resize(cols, rows); } catch { /* Process may exit while attaching. */ }

    let detached = false;
    return {
      input: (data) => {
        if (!detached && data.length <= 64 * 1024) managed!.terminal.write(data);
      },
      resize: (nextCols, nextRows) => {
        if (!detached && Number.isInteger(nextCols) && Number.isInteger(nextRows) && nextCols >= 20 && nextCols <= 400 && nextRows >= 5 && nextRows <= 200) managed!.terminal.resize(nextCols, nextRows);
      },
      detach: () => {
        if (detached) return;
        detached = true;
        if (managed!.client === client) managed!.client = null;
        if (!managed!.retained) this.scheduleIdleStop(managed!);
      },
    };
  }

  close(): void {
    for (const managed of this.sessions.values()) this.stop(managed);
    this.sessions.clear();
  }

  private create(binding: PtyBinding, cols: number, rows: number, startupArgs?: string[], environment = this.environment, retained = false, signalFile: string | null = null): ManagedPty {
    const args = startupArgs ?? ["--session", binding.sessionFile, "-a", ...(this.extensionPath ? ["-e", this.extensionPath] : [])];
    if (!signalFile) {
      mkdirSync(this.signalDirectory, { recursive: true, mode: 0o700 });
      signalFile = path.join(this.signalDirectory, `${binding.issueKey.toLowerCase()}.settled`);
      writeFileSync(signalFile, "", { mode: 0o600 });
      environment = { ...environment, ISSUE_PILOT_SETTLED_SIGNAL_FILE: signalFile };
    }
    const terminal = spawnPty(this.piExecutable, args, {
      name: "xterm-256color",
      cols: Math.max(20, Math.min(400, cols)),
      rows: Math.max(5, Math.min(200, rows)),
      cwd: binding.workspacePath,
      env: environment,
    });
    let resolveExit!: (exitCode: number) => void;
    const exit = new Promise<number>((resolve) => { resolveExit = resolve; });
    const managed: ManagedPty = { binding, terminal, client: null, backlog: "", idleTimer: null, retained, signalFile, exit };
    this.sessions.set(binding.issueId, managed);
    terminal.onData((data) => {
      managed.backlog += data;
      if (managed.backlog.length > 2 * 1024 * 1024) managed.backlog = managed.backlog.slice(-1024 * 1024);
      managed.client?.output(data);
    });
    terminal.onExit(({ exitCode }) => {
      if (managed.idleTimer) clearTimeout(managed.idleTimer);
      managed.client?.exit(exitCode);
      resolveExit(exitCode);
      if (this.sessions.get(binding.issueId) === managed) this.sessions.delete(binding.issueId);
    });
    return managed;
  }

  private async waitForSettlement(managed: ManagedPty, baseline: number): Promise<void> {
    if (!managed.signalFile) throw new Error("pi_settlement_signal_not_configured");
    const settled = (async () => {
      while (this.sessions.get(managed.binding.issueId) === managed) {
        const size = await stat(managed.signalFile!).then((value) => value.size, () => 0);
        if (size > baseline) return;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error("pi_terminal_exited_before_settling");
    })();
    const exit = managed.exit.then((exitCode) => { throw new Error(`pi_terminal_exited_before_settling:${exitCode}`); });
    await Promise.race([settled, exit]);
  }

  private scheduleIdleStop(managed: ManagedPty): void {
    if (managed.idleTimer || managed.client || managed.retained) return;
    managed.idleTimer = setTimeout(() => this.stop(managed), this.idleTimeoutMs);
    managed.idleTimer.unref();
  }

  private stop(managed: ManagedPty): void {
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    managed.idleTimer = null;
    try { managed.terminal.kill(); } catch { /* Process already exited. */ }
    if (this.sessions.get(managed.binding.issueId) === managed) this.sessions.delete(managed.binding.issueId);
  }
}
