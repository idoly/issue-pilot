import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SerialQueue } from "../serial.ts";
import { isManagedIssueFile } from "../workspace/work-files.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";

export interface IssueFilesystemPolicy { writeRoot: string; readRoots?: readonly string[]; networkDomains?: readonly string[]; gitAccess?: "write" | "read" }
export interface PreparedIssueCommand { argv: string[]; cleanup(): Promise<void> }
const lifecycle = new SerialQueue();
async function executable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const file = path.resolve(directory, name);
    try { await access(file, constants.X_OK); return await realpath(file); } catch { /* Continue the trusted application's PATH lookup. */ }
  }
  throw new Error("issue_sandbox_unavailable");
}
let users = 0;
export async function acquireIssueSandbox(): Promise<() => Promise<void>> {
  await lifecycle.run(async () => {
    if (!users) {
      if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new Error("issue_sandbox_unavailable");
      const dependencies = await SandboxManager.checkDependenciesAsync();
      if (dependencies.errors.length || dependencies.warnings.length) throw new Error("issue_sandbox_unavailable");
      try {
        await SandboxManager.initialize({
          filesystem: { allowWrite: [], denyRead: [], denyWrite: [] },
          network: { allowedDomains: [...issuePilotConfig.runtime.agent.networkAllowedDomains], deniedDomains: ["localhost", `*:${issuePilotConfig.http.port}`, `*:${issuePilotConfig.web.port}`, ...Object.values(os.networkInterfaces()).flatMap(items => (items ?? []).map(item => item.address))], allowAllUnixSockets: false, tlsTerminate: undefined },
          bwrapPath: await executable("bwrap"), socatPath: await executable("socat"), ripgrep: { command: await executable("rg") },
          allowNestedUserNamespaces: false, enableWeakerNestedSandbox: false,
        });
      } catch (error) { try { await SandboxManager.reset(); } catch (cleanup) { throw new AggregateError([error, cleanup], "issue_sandbox_start_cleanup_failed"); } throw error; }
    }
    users++;
  });
  let released = false;
  return () => lifecycle.run(async () => { if (released) return; released = true; if (--users === 0) await SandboxManager.reset(); });
}
const within = (root: string, value: string) => { const relative = path.relative(root, value); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
/** One SRT boundary for local tools and stdio MCP. Policy is immutable for each invocation. */
export async function prepareIssueCommand(policy: IssueFilesystemPolicy, command: readonly string[], cwd = policy.writeRoot): Promise<PreparedIssueCommand> {
  const root = path.resolve(policy.writeRoot);
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new Error("invalid_issue_sandbox_root");
  const gitRoot = path.join(root, ".issue-git");
  await mkdir(gitRoot, { recursive: true, mode: 0o700 });
  if (await realpath(gitRoot) !== gitRoot || !(await lstat(gitRoot)).isDirectory()) throw new Error("workspace_git_store_invalid");
  const directory = await realpath(cwd);
  if (!within(root, directory)) throw new Error("issue_sandbox_cwd_outside_issue");
  if (!command.length || command.some(value => value.includes("\0"))) throw new Error("invalid_issue_command");
  const id = randomUUID(), release = await acquireIssueSandbox(), config = path.join(root, `.runtime-proxy-${id}.conf`);
  let wrapped = false;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= cleanupResources();
  const cleanupResources = async () => {
    const failures: unknown[] = [];
    try { await rm(config, { force: true }); } catch (error) { failures.push(error); }
    try { SandboxManager.unregisterCommandNetworkLists(id); if (wrapped) SandboxManager.cleanupAfterCommand(); } catch (error) { failures.push(error); }
    try { await release(); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "issue_sandbox_cleanup_failed");
  };
  try {
    const denyWrite = ["/tmp/claude", "/private/tmp/claude", path.join(os.homedir(), ".npm/_logs"), path.join(os.homedir(), ".claude/debug")];
    if (policy.gitAccess === "read") denyWrite.push(gitRoot);
    else for (const name of await readdir(gitRoot)) {
      if (!/^[a-f0-9]{20}$/.test(name)) throw new Error("workspace_git_store_requires_inspection");
      const file = path.join(gitRoot, name);
      denyWrite.push(path.join(file, "config"), path.join(file, "hooks"), path.join(file, "issue-pilot-published.json"), path.join(file, "objects/info/alternates"));
      for (const worktree of await readdir(path.join(file, "worktrees")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })) {
        for (const protectedName of ["commondir", "gitdir", "config.worktree"]) denyWrite.push(path.join(file, "worktrees", worktree, protectedName));
      }
    }
    for (const name of await readdir(root)) {
      const file = path.join(root, name), info = await lstat(file);
      if (isManagedIssueFile(name) && info.isFile()) denyWrite.push(file);
      if (info.isDirectory()) {
        const git = path.join(file, ".git"), metadata = await lstat(git).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
        if (metadata?.isFile()) denyWrite.push(git);
      }
    }
    const agent = getAgentDir(), application = path.resolve(import.meta.dirname, "../..");
    const state = path.basename(path.dirname(root)) === "workspaces" ? path.dirname(path.dirname(root)) : undefined;
    const denyRead = [os.tmpdir(), path.join(os.homedir(), ".ssh"), path.join(agent, "auth.json"), path.join(agent, "mcp-auth.json"), path.join(agent, "models.json"), ...(state ? [state] : [])];
    const bridges = [SandboxManager.getLinuxHttpSocketPath(), SandboxManager.getLinuxSocksSocketPath()].filter((value): value is string => typeof value === "string");
    const allowRead = [root, application, agent, ...bridges, ...(policy.readRoots ?? []), ...(state ? [path.join(state, "git")] : [])];
    const entry = path.join(import.meta.dirname, "network-exec.ts");
    const invocation = [process.execPath, "--experimental-strip-types", entry, root, config, ...command];
    if (policy.networkDomains?.length) SandboxManager.registerCommandNetworkLists(id, { allowedDomains: [...policy.networkDomains] });
    const text = await SandboxManager.wrapWithSandbox(invocation.map(shellQuote).join(" "), "/bin/sh", {
      git: { safeDirectories: [root, `${root}/*`, ...(state ? [`${path.join(state, "git")}/*`] : [])] },
      filesystem: { allowWrite: [{ path: root, literal: true }], denyWrite: denyWrite.map(value => ({ path: value, literal: true })), denyRead: denyRead.map(value => ({ path: value, literal: true })), allowRead: allowRead.map(value => ({ path: value, literal: true })) },
    }, undefined, { commandId: id });
    wrapped = true;
    return { argv: ["/bin/sh", "-c", text], cleanup };
  } catch (error) { try { await cleanup(); } catch (failure) { throw new AggregateError([error, failure], "issue_sandbox_prepare_cleanup_failed"); } throw error; }
}
export function assertIssueLaunchEnvironment(environment: Readonly<Record<string, string>>): void {
  if (Object.keys(environment).some(name => name.startsWith("LD_") || ["GLIBC_TUNABLES", "BASH_ENV", "ENV"].includes(name))) throw new Error("unsafe_issue_launcher_environment");
}
export function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
