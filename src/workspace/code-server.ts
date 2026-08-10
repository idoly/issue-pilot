import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { issueRuntimeWorkspaceFile } from "./state.ts";

const execFileAsync = promisify(execFile);
const codeServerRuntime = issuePilotConfig.runtime.codeServer;

interface IssueRuntime {
  stateRoot: string;
  runtimeRoot: string;
  workspaceFile: string;
}

function issueRuntime(stateRoot: string, issueKey: string, workspacePath: string): IssueRuntime {
  const resolvedState = resolve(stateRoot);
  const workspaceFile = issueRuntimeWorkspaceFile(resolvedState, issueKey);
  const runtimeRoot = dirname(workspaceFile);
  if (resolve(workspacePath) !== runtimeRoot) throw new Error("invalid_code_server_workspace");
  return { stateRoot: resolvedState, runtimeRoot, workspaceFile };
}

function runtimeUrl(runtime: IssueRuntime, publicUrl: string): string {
  const relativePath = relative(runtime.stateRoot, runtime.runtimeRoot);
  const containerPath = `/home/coder/state/${relativePath.split("\\").join("/")}`;
  const url = new URL(publicUrl);
  url.searchParams.set("workspace", `${containerPath}/${basename(runtime.workspaceFile)}`);
  return url.toString();
}

export function issueCodeServerUrl(stateRoot: string, issueKey: string, workspacePath: string, publicUrl: string = codeServerRuntime.publicUrl): string {
  return runtimeUrl(issueRuntime(stateRoot, issueKey, workspacePath), publicUrl);
}

export class CodeServerManager {
  private readonly stateRoot: string;
  private readonly script: string;

  constructor(stateRoot: string) {
    this.stateRoot = resolve(stateRoot);
    this.script = fileURLToPath(new URL("../../infra/code-server.sh", import.meta.url));
  }

  async ensure(issueKey: string, workspacePath: string): Promise<string> {
    const runtime = issueRuntime(this.stateRoot, issueKey, workspacePath);
    await Promise.all([
      access(runtime.runtimeRoot),
      access(this.script),
      access(runtime.workspaceFile),
    ]);
    await execFileAsync(this.script, ["ensure", this.stateRoot], {
      timeout: issuePilotConfig.limits.process.codeServerEnsureMs,
      maxBuffer: issuePilotConfig.limits.process.codeServerOutputBytes,
    });
    return runtimeUrl(runtime, codeServerRuntime.publicUrl);
  }
}
