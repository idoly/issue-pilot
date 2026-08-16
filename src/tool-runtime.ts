import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { localCommandExecutor, type CommandExecutionOptions, type CommandExecutionResult, type CommandExecutor } from "./capabilities/local-exec.ts";

export interface ToolRunOptions {
  command: readonly string[];
  cwd?: string;
  environment?: Readonly<Record<string, string>>;
}

export interface ToolRuntime {
  run(options: ToolRunOptions, execution?: CommandExecutionOptions): Promise<CommandExecutionResult>;
}

const inheritedEnvironment = [
  "PATH", "JAVA_HOME", "MAVEN_HOME", "LANG", "LANGUAGE", "LC_ALL", "TZ",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
] as const;

function processCommand(command: readonly string[]): { command: string; args: string[] } {
  if (!command.length || command.some((argument) => argument.includes("\0"))) throw new Error("invalid_tool_configuration");
  const [executable, ...args] = command;
  if (executable === "npm" || executable === "mvn") return { command: executable, args };
  if (executable === "aliyun" && (args[0] === "dms-enterprise" || args[0] === "sls")) return { command: executable, args };
  throw new Error("tool_command_not_allowed");
}

export class ProcessToolRuntime implements ToolRuntime {
  private readonly executor: CommandExecutor;

  constructor(executor: CommandExecutor = localCommandExecutor) {
    this.executor = executor;
  }

  async run(options: ToolRunOptions, execution?: CommandExecutionOptions): Promise<CommandExecutionResult> {
    if (options.cwd && (!path.isAbsolute(options.cwd) || options.cwd.includes("\0"))) throw new Error("invalid_tool_configuration");
    if (execution?.cwd || execution?.environment) throw new Error("tool_execution_override_not_allowed");
    for (const [name, value] of Object.entries(options.environment ?? {})) {
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(name) || value.includes("\0")) throw new Error("invalid_tool_configuration");
    }
    const selected = processCommand(options.command);
    const temporaryHome = options.environment?.HOME ? undefined : await mkdtemp(path.join(os.tmpdir(), "issue-pilot-tool-"));
    try {
      const environment: Record<string, string> = {};
      for (const name of inheritedEnvironment) {
        const value = process.env[name];
        if (value !== undefined) environment[name] = value;
      }
      Object.assign(environment, options.environment, { HOME: options.environment?.HOME ?? temporaryHome! });
      return await this.executor.execute(selected.command, selected.args, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        environment,
        ...(execution?.timeout !== undefined ? { timeout: execution.timeout } : {}),
        ...(execution?.signal ? { signal: execution.signal } : {}),
        ...(execution?.maxOutputBytes !== undefined ? { maxOutputBytes: execution.maxOutputBytes } : {}),
      });
    } finally {
      if (temporaryHome) await rm(temporaryHome, { recursive: true, force: true });
    }
  }
}

export const processToolRuntime: ToolRuntime = new ProcessToolRuntime();
