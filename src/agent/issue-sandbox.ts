import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { BlockList, isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SerialQueue } from "../serial.ts";
import { isManagedIssueFile } from "../workspace/work-files.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { applicationParameters } from "../configuration/parameters.ts";

export interface IssueFilesystemPolicy {
  writeRoot: string;
  /** Application state root; callers that know it make the read deny unconditional instead of inferred. */
  stateRoot?: string;
  readRoots?: readonly string[];
  networkDomains?: readonly string[];
  /** Only fixed bound-branch commands may grant writes to a selected private store. */
  writableGitStore?: string;
  /** Pi agent directory whose resource subpaths are readable; defaults to getAgentDir(). */
  agentDirectory?: string;
}
export interface PreparedIssueCommand {
  argv: string[];
  cleanup(): Promise<void>;
}
const lifecycle = new SerialQueue();
async function executable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const file = path.resolve(directory, name);
    try {
      await access(file, constants.X_OK);
      return await realpath(file);
    } catch (error) {
      // A missing entry is a normal PATH miss; any other failure means the configured binary is unusable.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw new Error("issue_sandbox_unavailable", { cause: error });
    }
  }
  throw new Error("issue_sandbox_unavailable");
}
let users = 0;
// The open-mode callback runs only after SRT's explicit deny/allow rules. SRT guards DNS
// results, but IP-literal requests skip that guard, so keep automatic grants off host
// control and metadata addresses too. Private business networks remain reachable.
const automaticNetworkDeny = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["224.0.0.0", 4],
] as const)
  automaticNetworkDeny.addSubnet(address, prefix, "ipv4");
for (const address of ["255.255.255.255", "100.100.100.200", "168.63.129.16", "192.0.0.192"]) automaticNetworkDeny.addAddress(address, "ipv4");
for (const [address, prefix] of [
  ["fe80::", 10],
  ["ff00::", 8],
  ["fd00:ec2::", 32],
] as const)
  automaticNetworkDeny.addSubnet(address, prefix, "ipv6");
for (const address of ["::", "::1", "fd20:ce::254", "fd00:c1::a9fe:a9fe", "fd00:42::42", "fd00:a9fe:a9fe::1", "fd00:100::100:200"]) automaticNetworkDeny.addAddress(address, "ipv6");

function allowOpenNetworkTarget(host: string): boolean {
  if (applicationParameters().networkMode !== "open") return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${isIP(host) === 6 ? `[${host}]` : host}`).hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "")
      .toLowerCase();
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
  const family = isIP(hostname);
  if (!family) return true;
  const type = family === 6 ? "ipv6" : "ipv4";
  if (automaticNetworkDeny.check(hostname, type)) return false;
  const local = new BlockList();
  for (const item of Object.values(os.networkInterfaces()).flatMap((items) => items ?? [])) local.addAddress(item.address.split("%", 1)[0]!, item.family === "IPv6" ? "ipv6" : "ipv4");
  return !local.check(hostname, type);
}

// The proxy reads the configured allow list on each connection, so replacing it reaches running sessions too.
function syncNetworkAllowedDomains(): void {
  const configured = SandboxManager.getConfig();
  const allowedDomains = [...applicationParameters().networkAllowedDomains];
  if (!configured || JSON.stringify(configured.network.allowedDomains) === JSON.stringify(allowedDomains)) return;
  SandboxManager.updateConfig({ ...configured, network: { ...configured.network, allowedDomains } });
}

/** Applies a saved base network list to the shared sandbox; a stopped sandbox reads it when it next starts. */
export function applyIssueSandboxNetwork(): Promise<void> {
  return lifecycle.run(async () => {
    if (users) syncNetworkAllowedDomains();
  });
}

async function acquireIssueSandbox(): Promise<() => Promise<void>> {
  await lifecycle.run(async () => {
    if (!users) {
      if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new Error("issue_sandbox_unavailable");
      const dependencies = await SandboxManager.checkDependenciesAsync();
      if (dependencies.errors.length || dependencies.warnings.length) throw new Error("issue_sandbox_unavailable");
      try {
        await SandboxManager.initialize(
          {
            filesystem: { allowWrite: [], denyRead: [], denyWrite: [] },
            network: {
              allowedDomains: [...applicationParameters().networkAllowedDomains],
              deniedDomains: [
                "localhost",
                `*:${issuePilotConfig.http.port}`,
                `*:${issuePilotConfig.web.port}`,
                ...Object.values(os.networkInterfaces()).flatMap((items) => (items ?? []).map((item) => item.address)),
              ],
              allowAllUnixSockets: false,
              tlsTerminate: undefined,
            },
            bwrapPath: await executable("bwrap"),
            socatPath: await executable("socat"),
            ripgrep: { command: await executable("rg") },
            allowNestedUserNamespaces: false,
            enableWeakerNestedSandbox: false,
          },
          async ({ host }) => allowOpenNetworkTarget(host),
        );
      } catch (error) {
        try {
          await SandboxManager.reset();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], "issue_sandbox_start_cleanup_failed");
        }
        throw error;
      }
    } else syncNetworkAllowedDomains();
    users++;
  });
  let released = false;
  return () =>
    lifecycle.run(async () => {
      if (released) return;
      released = true;
      if (--users === 0) await SandboxManager.reset();
    });
}
const within = (root: string, value: string) => {
  const relative = path.relative(root, value);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
// Agent-directory entries sandboxed tools need: Pi's fd/rg downloads and skill files the model reads,
// including skills shipped by installed npm/git packages. Credentials, settings, sessions, editor
// swap files and every unlisted entry stay hidden.
const agentReadableEntries = ["bin", "skills", "npm", "git"];
// Home entries sandboxed tools need: the documented user-level host tool prefix (pip, global Pi, the
// Python user site with openpyxl) and Pi's user-level ~/.agents/skills. Everything else in the home
// directory (checkpoint databases, logs, Git/npm/cloud credentials, other agents' state) is hidden.
const homeReadableEntries = [".local/bin", ".local/lib", ".agents/skills"];
export interface IssueReadPolicyInput {
  root: string;
  application: string;
  /** Agent directory whose resources the command may read. */
  agent: string;
  /** The process-wide Operator agent directory; its secrets are denied even when a test selects another. */
  operatorAgent: string;
  /** HOME and the account's password-database home; both are denied when they differ. */
  homes: readonly string[];
  temporary: string;
  state?: string;
  bridges: readonly string[];
  readRoots: readonly string[];
}
/**
 * Deny-by-default read policy over the host home: SRT mounts a tmpfs over each denied directory and
 * ro-binds allowRead paths back (allowRead wins inside a denied directory; deeper denies are applied
 * after shallower ones, and a directory allow never lifts a specific file deny).
 */
export function issueReadPolicy(input: IssueReadPolicyInput): { denyRead: string[]; allowRead: string[] } {
  const homes = [...new Set(input.homes.filter((home) => path.isAbsolute(home) && path.resolve(home) !== "/").map((home) => path.resolve(home)))];
  const agentSecrets = (agent: string) => ["auth.json", "mcp-auth.json", "models.json", "sessions"].map((name) => path.join(agent, name));
  const agents = [...new Set([input.agent, input.operatorAgent])];
  const denyRead = [
    input.temporary,
    ...homes,
    ...homes.map((home) => path.join(home, ".ssh")),
    ...agents.flatMap(agentSecrets),
    // A test-selected agent directory may be the Issue root itself; never hide the root that way.
    ...agents.filter((agent) => !within(agent, input.root) && !within(input.root, agent)),
    ...(input.state ? [input.state] : []),
  ];
  const allowRead = [
    input.root,
    input.application,
    ...agentReadableEntries.map((name) => path.join(input.agent, name)),
    ...homes.flatMap((home) => homeReadableEntries.map((name) => path.join(home, name))),
    ...input.bridges,
    ...input.readRoots,
  ];
  return { denyRead: [...new Set(denyRead)], allowRead: [...new Set(allowRead)] };
}
// HOME can be overridden; the password-database home is where the account's real files live.
function accountHome(): string[] {
  try {
    return [os.userInfo().homedir];
  } catch {
    return [];
  }
}
/** One SRT boundary for local tools and stdio MCP. Policy is immutable for each invocation. */
export async function prepareIssueCommand(policy: IssueFilesystemPolicy, command: readonly string[], cwd = policy.writeRoot): Promise<PreparedIssueCommand> {
  const root = path.resolve(policy.writeRoot);
  // A known state root makes the boundary explicit: a workspace outside it would otherwise lose the state deny.
  const knownStateRoot = policy.stateRoot === undefined ? undefined : path.resolve(policy.stateRoot);
  if (knownStateRoot && !within(path.join(knownStateRoot, "workspaces"), root)) throw new Error("issue_sandbox_root_outside_state");
  if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory()) throw new Error("invalid_issue_sandbox_root");
  const gitRoot = path.join(root, ".issue-git");
  await mkdir(gitRoot, { recursive: true, mode: 0o700 });
  if ((await realpath(gitRoot)) !== gitRoot || !(await lstat(gitRoot)).isDirectory()) throw new Error("workspace_git_store_invalid");
  const writableStore = policy.writableGitStore;
  if (writableStore && (path.dirname(writableStore) !== gitRoot || !/^[a-f0-9]{20}$/.test(path.basename(writableStore)) || (await realpath(writableStore)) !== writableStore))
    throw new Error("workspace_git_store_invalid");
  const directory = await realpath(cwd);
  if (!within(root, directory)) throw new Error("issue_sandbox_cwd_outside_issue");
  if (!command.length || command.some((value) => value.includes("\0"))) throw new Error("invalid_issue_command");
  const id = randomUUID(),
    release = await acquireIssueSandbox(),
    config = path.join(root, `.runtime-proxy-${id}.conf`);
  let wrapped = false;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => (cleanupPromise ??= cleanupResources());
  const cleanupResources = async () => {
    const failures: unknown[] = [];
    try {
      await rm(config, { force: true });
    } catch (error) {
      failures.push(error);
    }
    try {
      SandboxManager.unregisterCommandNetworkLists(id);
      if (wrapped) SandboxManager.cleanupAfterCommand();
    } catch (error) {
      failures.push(error);
    }
    try {
      await release();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "issue_sandbox_cleanup_failed");
  };
  try {
    const denyWrite = ["/tmp/claude", "/private/tmp/claude", path.join(os.homedir(), ".npm/_logs"), path.join(os.homedir(), ".claude/debug")];
    if (!writableStore) denyWrite.push(gitRoot);
    else
      for (const name of await readdir(gitRoot)) {
        const file = path.join(gitRoot, name);
        if (file !== writableStore) {
          denyWrite.push(file);
          continue;
        }
        for (const control of ["HEAD", "config", "hooks", "issue-pilot-published.json", "objects/info/alternates"]) denyWrite.push(path.join(file, control));
        for (const worktree of await readdir(path.join(file, "worktrees")).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        })) {
          for (const protectedName of ["HEAD", "commondir", "gitdir", "config.worktree"]) denyWrite.push(path.join(file, "worktrees", worktree, protectedName));
        }
      }
    // This is a snapshot: managed files created later stay writable to this sandbox. Owners therefore write
    // attachments and session files only while no sandboxed process of the Issue is alive (reservation + closeSession).
    for (const name of await readdir(root)) {
      const file = path.join(root, name),
        info = await lstat(file);
      if (isManagedIssueFile(name) && info.isFile()) denyWrite.push(file);
      if (info.isDirectory()) {
        const git = path.join(file, ".git"),
          metadata = await lstat(git).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
        if (metadata) denyWrite.push(git);
      }
    }
    const state = knownStateRoot ?? (path.basename(path.dirname(root)) === "workspaces" ? path.dirname(path.dirname(root)) : undefined);
    const { denyRead, allowRead } = issueReadPolicy({
      root,
      application: path.resolve(import.meta.dirname, "../.."),
      agent: policy.agentDirectory ? path.resolve(policy.agentDirectory) : getAgentDir(),
      operatorAgent: getAgentDir(),
      homes: [os.homedir(), ...accountHome()],
      temporary: os.tmpdir(),
      ...(state ? { state } : {}),
      bridges: [SandboxManager.getLinuxHttpSocketPath(), SandboxManager.getLinuxSocksSocketPath()].filter((value): value is string => typeof value === "string"),
      readRoots: policy.readRoots ?? [],
    });
    const entry = path.join(import.meta.dirname, "network-exec.ts");
    const invocation = [process.execPath, "--experimental-strip-types", entry, root, config, ...command];
    if (policy.networkDomains?.length) SandboxManager.registerCommandNetworkLists(id, { allowedDomains: [...policy.networkDomains] });
    const text = await SandboxManager.wrapWithSandbox(
      invocation.map(shellQuote).join(" "),
      "/bin/sh",
      {
        git: { safeDirectories: [root, `${root}/*`, ...(state ? [`${path.join(state, "git")}/*`] : [])] },
        filesystem: {
          allowWrite: [{ path: root, literal: true }],
          denyWrite: denyWrite.map((value) => ({ path: value, literal: true })),
          denyRead: denyRead.map((value) => ({ path: value, literal: true })),
          allowRead: allowRead.map((value) => ({ path: value, literal: true })),
        },
      },
      undefined,
      { commandId: id },
    );
    wrapped = true;
    return { argv: ["/bin/sh", "-c", text], cleanup };
  } catch (error) {
    try {
      await cleanup();
    } catch (failure) {
      throw new AggregateError([error, failure], "issue_sandbox_prepare_cleanup_failed");
    }
    throw error;
  }
}
export function assertIssueLaunchEnvironment(environment: Readonly<Record<string, string>>): void {
  if (Object.keys(environment).some((name) => name.startsWith("LD_") || ["GLIBC_TUNABLES", "BASH_ENV", "ENV"].includes(name))) throw new Error("unsafe_issue_launcher_environment");
}
export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
