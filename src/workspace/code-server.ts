import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { normalizeIssueKey } from "../domain/contracts.ts";
import { issueRuntimeRoot, issueWorkspaceRoot } from "./state.ts";

const execFileAsync = promisify(execFile);

export function issueCodeServerUrl(stateRoot: string, issueKey: string, workspacePath: string, publicUrl = "http://127.0.0.1:18080/"): string {
  const normalized = normalizeIssueKey(issueKey);
  const resolvedState = resolve(stateRoot);
  const resolvedWorkspace = resolve(workspacePath);
  const expected = new Set([issueWorkspaceRoot(resolvedState, normalized), issueRuntimeRoot(resolvedState, normalized)]);
  if (!expected.has(resolvedWorkspace)) throw new Error("invalid_code_server_workspace");
  const relativePath = relative(resolvedState, resolvedWorkspace);
  const url = new URL(publicUrl);
  url.searchParams.set("folder", `/home/coder/state/${relativePath.split("\\").join("/")}`);
  return url.toString();
}

export class CodeServerManager {
  private readonly stateRoot: string;
  private readonly script: string;
  private readonly publicUrl: URL;

  constructor(stateRoot: string) {
    this.stateRoot = resolve(stateRoot);
    this.script = fileURLToPath(new URL("../../infra/code-server.sh", import.meta.url));
    this.publicUrl = new URL("http://127.0.0.1:18080/");
  }

  async ensure(issueKey: string, workspacePath: string): Promise<string> {
    const normalized = normalizeIssueKey(issueKey);
    const resolvedWorkspace = resolve(workspacePath);
    const expected = new Set([issueWorkspaceRoot(this.stateRoot, normalized), issueRuntimeRoot(this.stateRoot, normalized)]);
    if (!expected.has(resolvedWorkspace)) throw new Error("invalid_code_server_workspace");
    await Promise.all([access(resolvedWorkspace), access(this.script)]);
    await execFileAsync(this.script, ["ensure"], { timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
    return issueCodeServerUrl(this.stateRoot, normalized, resolvedWorkspace, this.publicUrl.toString());
  }
}
