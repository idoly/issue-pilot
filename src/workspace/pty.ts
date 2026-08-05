import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { spawn as spawnPty, type IPty } from "node-pty";

export interface PtyBinding {
  issueId: string;
  issueKey: string;
  sessionFile: string;
  workspacePath: string;
  policyHash: string;
  tools: string[];
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
  transcriptFile: string;
  transcriptMetaFile: string;
  transcriptTimer: NodeJS.Timeout | null;
  transcriptWrite: Promise<void>;
  transcriptValid: boolean;
  stopping: boolean;
  exit: Promise<number>;
}

export interface PtyRunOptions {
  prompt: string;
  provider: string;
  model: string;
  thinking: string;
}

export interface PtyTranscript {
  data: string;
  columns: number;
  rows: number;
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

  abort(issueId: string): boolean {
    const managed = this.sessions.get(issueId);
    if (!managed) return false;
    managed.terminal.write("\x1b");
    return true;
  }

  async execute(binding: PtyBinding, options: PtyRunOptions): Promise<void> {
    let managed = this.sessions.get(binding.issueId);
    if (managed && !this.sameBinding(managed.binding, binding)) {
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
      await this.enqueueInternalMessage(binding, options.prompt);
    } else {
      await mkdir(this.signalDirectory, { recursive: true, mode: 0o700 });
      const signalFile = path.join(this.signalDirectory, `${binding.issueKey.toLowerCase()}.settled`);
      await writeFile(signalFile, "", { mode: 0o600 });
      const messageDirectory = this.internalMessageDirectory(binding);
      await rm(messageDirectory, { recursive: true, force: true });
      await mkdir(messageDirectory, { recursive: true, mode: 0o700 });
      await chmod(messageDirectory, 0o700);
      await this.enqueueInternalMessage(binding, options.prompt);
      const args = [
        "--session", binding.sessionFile,
        "--no-approve",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-builtin-tools",
        "--tools", binding.tools.join(","),
        "--provider", options.provider,
        "--model", options.model,
        "--thinking", options.thinking,
      ];
      if (this.extensionPath) args.push("--extension", this.extensionPath);
      const transcript = await this.readTranscript(binding.sessionFile);
      managed = this.create(binding, 100, 30, args, {
        ...this.environment,
        ISSUE_PILOT_POLICY_REQUIRED: "1",
        ISSUE_PILOT_SETTLED_SIGNAL_FILE: signalFile,
        ISSUE_PILOT_INTERNAL_MESSAGE_DIRECTORY: messageDirectory,
      }, true, signalFile, transcript?.data ?? "");
    }

    await this.waitForSettlement(managed, baseline);
    managed.retained = false;
    if (!managed.client) this.scheduleIdleStop(managed);
  }

  async release(issueId: string): Promise<boolean> {
    const managed = this.sessions.get(issueId);
    if (!managed) return true;
    return this.stopAndWait(managed);
  }

  async releaseDetached(issueId: string): Promise<boolean> {
    const managed = this.sessions.get(issueId);
    if (!managed) return true;
    if (managed.client) return false;
    return this.stopAndWait(managed);
  }

  attach(binding: PtyBinding, client: PtyClient, cols: number, rows: number): PtyAttachment {
    const managed = this.sessions.get(binding.issueId);
    if (!managed || !this.sameBinding(managed.binding, binding)) throw new Error("pi_terminal_not_runner_owned");
    if (managed.client) throw new Error("pi_terminal_already_open");
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

  async readTranscript(sessionFile: string): Promise<PtyTranscript | null> {
    try {
      const [data, metadata] = await Promise.all([
        readFile(this.transcriptFile(sessionFile), "utf8"),
        readFile(this.transcriptMetaFile(sessionFile), "utf8").then((value) => JSON.parse(value) as { columns?: unknown; rows?: unknown }),
      ]);
      if (!Number.isInteger(metadata.columns) || !Number.isInteger(metadata.rows)) return null;
      const columns = metadata.columns as number;
      const rows = metadata.rows as number;
      if (columns < 20 || columns > 400 || rows < 5 || rows > 200) return null;
      return { data, columns, rows };
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    const managedSessions = [...this.sessions.values()];
    for (const managed of managedSessions) this.stop(managed);
    this.sessions.clear();
    await Promise.all(managedSessions.map((managed) => managed.transcriptWrite));
  }

  private create(binding: PtyBinding, cols: number, rows: number, args: string[], environment: NodeJS.ProcessEnv, retained: boolean, signalFile: string, backlog: string): ManagedPty {
    const terminal = spawnPty(this.piExecutable, args, {
      name: "xterm-256color",
      cols: Math.max(20, Math.min(400, cols)),
      rows: Math.max(5, Math.min(200, rows)),
      cwd: binding.workspacePath,
      env: environment,
    });
    let resolveExit!: (exitCode: number) => void;
    const exit = new Promise<number>((resolve) => { resolveExit = resolve; });
    const managed: ManagedPty = {
      binding,
      terminal,
      client: null,
      backlog,
      idleTimer: null,
      retained,
      signalFile,
      transcriptFile: this.transcriptFile(binding.sessionFile),
      transcriptMetaFile: this.transcriptMetaFile(binding.sessionFile),
      transcriptTimer: null,
      transcriptWrite: Promise.resolve(),
      transcriptValid: true,
      stopping: false,
      exit,
    };
    this.sessions.set(binding.issueId, managed);
    terminal.onData((data) => {
      managed.backlog += data;
      if (managed.backlog.length > 8 * 1024 * 1024) {
        managed.backlog = "";
        managed.transcriptValid = false;
      }
      this.scheduleTranscriptWrite(managed);
      managed.client?.output(data);
    });
    terminal.onExit(({ exitCode }) => {
      if (managed.idleTimer) clearTimeout(managed.idleTimer);
      if (!managed.stopping) this.flushTranscript(managed);
      managed.client?.exit(exitCode);
      resolveExit(exitCode);
      if (this.sessions.get(binding.issueId) === managed) this.sessions.delete(binding.issueId);
    });
    return managed;
  }

  private internalMessageDirectory(binding: PtyBinding): string {
    return path.join(this.signalDirectory, `${binding.issueKey.toLowerCase()}.messages`);
  }

  private async enqueueInternalMessage(binding: PtyBinding, content: string): Promise<void> {
    if (!content.trim() || Buffer.byteLength(content, "utf8") > 256 * 1024) throw new Error("invalid_issue_internal_message");
    const directory = this.internalMessageDirectory(binding);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const files = await readdir(directory);
    if (files.filter((name) => name.endsWith(".json")).length >= 4) throw new Error("issue_internal_message_queue_full");
    const id = `${Date.now().toString().padStart(16, "0")}-${randomUUID()}`;
    const temporaryFile = path.join(directory, `.${id}.tmp`);
    const messageFile = path.join(directory, `${id}.json`);
    await writeFile(temporaryFile, JSON.stringify({ content }), { mode: 0o600 });
    await chmod(temporaryFile, 0o600);
    await rename(temporaryFile, messageFile);
  }

  private transcriptFile(sessionFile: string): string {
    return `${sessionFile}.pty`;
  }

  private transcriptMetaFile(sessionFile: string): string {
    return `${sessionFile}.pty.json`;
  }

  private scheduleTranscriptWrite(managed: ManagedPty): void {
    if (managed.transcriptTimer) return;
    managed.transcriptTimer = setTimeout(() => {
      managed.transcriptTimer = null;
      this.flushTranscript(managed);
    }, 100);
    managed.transcriptTimer.unref();
  }

  private flushTranscript(managed: ManagedPty): void {
    if (managed.transcriptTimer) clearTimeout(managed.transcriptTimer);
    managed.transcriptTimer = null;
    const transcript = managed.transcriptValid ? managed.backlog : "";
    managed.transcriptWrite = managed.transcriptWrite
      .then(async () => {
        await writeFile(managed.transcriptFile, transcript, { mode: 0o600 });
        await writeFile(managed.transcriptMetaFile, JSON.stringify({ columns: managed.terminal.cols, rows: managed.terminal.rows }), { mode: 0o600 });
      })
      .catch(() => undefined);
  }

  private sameBinding(left: PtyBinding, right: PtyBinding): boolean {
    return left.sessionFile === right.sessionFile
      && left.workspacePath === right.workspacePath
      && left.policyHash === right.policyHash
      && left.tools.join(",") === right.tools.join(",");
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

  private async stopAndWait(managed: ManagedPty): Promise<boolean> {
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

  private stop(managed: ManagedPty): void {
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    managed.idleTimer = null;
    this.flushTranscript(managed);
    managed.stopping = true;
    try { managed.terminal.kill(); } catch { /* Process already exited. */ }
    if (this.sessions.get(managed.binding.issueId) === managed) this.sessions.delete(managed.binding.issueId);
  }
}
