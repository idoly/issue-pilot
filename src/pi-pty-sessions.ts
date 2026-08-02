import { spawn as spawnPty, type IPty } from "node-pty";

export interface PiPtyBinding {
  issueId: string;
  issueKey: string;
  sessionFile: string;
  workspacePath: string;
}

export interface PiPtyClient {
  output(data: string): void;
  exit(exitCode: number): void;
}

export interface PiPtyAttachment {
  input(data: string): void;
  resize(cols: number, rows: number): void;
  detach(): void;
}

interface ManagedPty {
  binding: PiPtyBinding;
  terminal: IPty;
  client: PiPtyClient | null;
  backlog: string;
  idleTimer: NodeJS.Timeout | null;
}

export class PiPtySessionManager {
  private readonly sessions = new Map<string, ManagedPty>();
  private readonly piExecutable: string;
  private readonly extensionPath: string | null;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly idleTimeoutMs: number;

  constructor(piExecutable: string, extensionPath: string | null, environment: NodeJS.ProcessEnv, idleTimeoutMs = 30 * 60_000) {
    this.piExecutable = piExecutable;
    this.extensionPath = extensionPath;
    this.environment = environment;
    this.idleTimeoutMs = idleTimeoutMs;
  }

  isAttached(issueId: string): boolean {
    return this.sessions.get(issueId)?.client !== null && this.sessions.get(issueId)?.client !== undefined;
  }

  async releaseDetached(issueId: string): Promise<boolean> {
    const managed = this.sessions.get(issueId);
    if (!managed) return true;
    if (managed.client) return false;
    const exited = new Promise<void>((resolve) => { managed.terminal.onExit(() => resolve()); });
    this.stop(managed);
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(true), 5_000); }),
    ]);
    if (timeout) clearTimeout(timeout);
    return !timedOut;
  }

  attach(binding: PiPtyBinding, client: PiPtyClient, cols: number, rows: number): PiPtyAttachment {
    let managed = this.sessions.get(binding.issueId);
    if (managed && (managed.binding.sessionFile !== binding.sessionFile || managed.binding.workspacePath !== binding.workspacePath)) {
      if (managed.client) throw new Error("pi_terminal_already_open");
      this.stop(managed);
      managed = undefined;
    }
    if (managed?.client) throw new Error("pi_terminal_already_open");
    if (!managed) managed = this.create(binding, cols, rows);
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    managed.idleTimer = null;
    managed.client = client;
    if (managed.backlog) client.output(managed.backlog);
    try { managed.terminal.resize(cols, rows); } catch { /* PTY may have exited between attach and resize. */ }

    let detached = false;
    return {
      input: (data) => {
        if (detached || data.length > 64 * 1024) return;
        managed!.terminal.write(data);
      },
      resize: (nextCols, nextRows) => {
        if (detached) return;
        managed!.terminal.resize(nextCols, nextRows);
      },
      detach: () => {
        if (detached) return;
        detached = true;
        if (managed!.client === client) managed!.client = null;
        managed!.idleTimer = setTimeout(() => this.stop(managed!), this.idleTimeoutMs);
        managed!.idleTimer.unref();
      },
    };
  }

  close(): void {
    for (const managed of this.sessions.values()) this.stop(managed);
    this.sessions.clear();
  }

  private create(binding: PiPtyBinding, cols: number, rows: number): ManagedPty {
    const args = ["--session", binding.sessionFile, "-a"];
    if (this.extensionPath) args.push("-e", this.extensionPath);
    const terminal = spawnPty(this.piExecutable, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: binding.workspacePath,
      env: this.environment,
    });
    const managed: ManagedPty = { binding, terminal, client: null, backlog: "", idleTimer: null };
    this.sessions.set(binding.issueId, managed);
    terminal.onData((data) => {
      managed.backlog += data;
      if (managed.backlog.length > 2 * 1024 * 1024) managed.backlog = managed.backlog.slice(-1024 * 1024);
      managed.client?.output(data);
    });
    terminal.onExit(({ exitCode }) => {
      if (managed.idleTimer) clearTimeout(managed.idleTimer);
      managed.client?.exit(exitCode);
      if (this.sessions.get(binding.issueId) === managed) this.sessions.delete(binding.issueId);
    });
    return managed;
  }

  private stop(managed: ManagedPty): void {
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    managed.idleTimer = null;
    try { managed.terminal.kill(); } catch { /* PTY already exited. */ }
    if (this.sessions.get(managed.binding.issueId) === managed) this.sessions.delete(managed.binding.issueId);
  }
}
