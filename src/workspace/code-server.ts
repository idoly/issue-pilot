import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { normalizeIssueKey } from "../shared/issue-key.ts";

const execFileAsync = promisify(execFile);

export class CodeServer {
  private readonly workspaceRoot: string;
  private readonly script: string;
  private readonly publicUrl: URL;

  constructor(stateRoot: string) {
    this.workspaceRoot = resolve(stateRoot, "workspaces");
    this.script = resolve(process.env.ISSUE_PILOT_CODE_SERVER_SCRIPT ?? "infra/code-server.sh");
    this.publicUrl = new URL(process.env.ISSUE_PILOT_CODE_SERVER_URL ?? "http://127.0.0.1:18080/");
  }

  async ensure(issueKey: string, workspacePath: string): Promise<string> {
    const normalized = normalizeIssueKey(issueKey);
    const resolvedWorkspace = resolve(workspacePath);
    const fromRoot = relative(this.workspaceRoot, resolvedWorkspace);
    if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot) || fromRoot !== normalized.toLowerCase()) throw new Error("invalid_code_server_workspace");
    await Promise.all([access(resolvedWorkspace), access(this.script)]);
    await execFileAsync(this.script, ["ensure"], { timeout: 180_000, maxBuffer: 2 * 1024 * 1024, env: process.env });
    const url = new URL(this.publicUrl);
    url.searchParams.set("folder", `/home/coder/project/${normalized.toLowerCase()}`);
    return url.toString();
  }
}
