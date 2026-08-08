import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { normalizeIssueKey } from "../domain/contracts.ts";
import { workspacesRoot } from "./state.ts";

const execFileAsync = promisify(execFile);

export function issueCodeServerUrl(issueKey: string, publicUrl = "http://127.0.0.1:18080/"): string {
  const url = new URL(publicUrl);
  url.searchParams.set("folder", `/home/coder/state/workspaces/${normalizeIssueKey(issueKey).toLowerCase()}`);
  return url.toString();
}

export class CodeServer {
  private readonly workspaceRoot: string;
  private readonly script: string;
  private readonly publicUrl: URL;

  constructor(stateRoot: string) {
    this.workspaceRoot = workspacesRoot(stateRoot);
    this.script = resolve("infra/code-server.sh");
    this.publicUrl = new URL("http://127.0.0.1:18080/");
  }

  async ensure(issueKey: string, workspacePath: string): Promise<string> {
    const normalized = normalizeIssueKey(issueKey);
    const resolvedWorkspace = resolve(workspacePath);
    const fromRoot = relative(this.workspaceRoot, resolvedWorkspace);
    if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot) || fromRoot !== normalized.toLowerCase()) throw new Error("invalid_code_server_workspace");
    await Promise.all([access(resolvedWorkspace), access(this.script)]);
    await execFileAsync(this.script, ["ensure"], { timeout: 180_000, maxBuffer: 2 * 1024 * 1024, env: process.env });
    return issueCodeServerUrl(normalized, this.publicUrl.toString());
  }
}
