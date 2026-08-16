import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConnection } from "node:net";

import { eq } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { processToolRuntime, type ToolRuntime } from "../tool-runtime.ts";
import type { Database } from "../db/client.ts";
import { environments, issueRepositories, issues } from "../db/schema.ts";
import { ISSUE_TYPES_BY_ENVIRONMENT, normalizeIssueKey } from "../domain/contracts.ts";
import { KeyedSerialQueue } from "../serial.ts";
import { classifyRepositoryState, issueWorkspaceRoot } from "./state.ts";

const requestBytes = 64 * 1024;
const argumentCount = 64;
const argumentCharacters = 4096;
const NODE_PROJECT_ACTIONS = ["install", "test", "build", "typecheck"] as const;
const MAVEN_PROJECT_ACTIONS = ["test", "verify", "package"] as const;
const stableRequestErrors = new Set([
  "invalid_project_tool_request",
  "invalid_project_tool_action",
  "invalid_project_tool_argument",
  "issue_not_found",
  "workspace_not_development",
  "development_repository_state_invalid",
  "workspace_repository_missing",
  "workspace_path_does_not_match_repository",
  "project_outside_issue_workspace",
  "project_manifest_not_found",
  "unsupported_package_manager",
]);

export type ProjectToolKind = "node" | "maven";

export interface ProjectToolRequest {
  tool: ProjectToolKind;
  issueKey: string;
  repository: string;
  project: string;
  action: string;
  args: string[];
}

export interface ProjectToolRuntime {
  node: { npmConfig: string; npmCache: string };
  maven: { settings: string; repository: string };
  executionMs: number;
}

function validWorkspaceName(value: string): boolean {
  return /^[a-z0-9._-]+$/.test(value);
}

function resolveOperatorPath(candidate: string): string {
  if (!candidate || candidate.includes("\0")) throw new Error("invalid_project_tool_configuration");
  return path.resolve(os.homedir(), candidate);
}

async function secureFile(candidate: string): Promise<string> {
  const resolved = await realpath(candidate);
  const metadata = await stat(resolved);
  const uid = process.getuid?.();
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || (uid !== undefined && metadata.uid !== uid)) throw new Error("insecure_project_tool_configuration");
  return resolved;
}

async function secureDirectory(candidate: string): Promise<string> {
  const resolved = await realpath(candidate);
  const metadata = await stat(resolved);
  const uid = process.getuid?.();
  if (!metadata.isDirectory() || (metadata.mode & 0o022) !== 0 || (uid !== undefined && metadata.uid !== uid)) throw new Error("insecure_project_tool_cache");
  return resolved;
}

function projectRelativePath(value: string): string {
  if (value.includes("\0") || path.isAbsolute(value)) throw new Error("project_outside_issue_workspace");
  const normalized = path.normalize(value || ".");
  if (normalized === ".") return "";
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) throw new Error("project_outside_issue_workspace");
  return normalized;
}

async function requestBody(request: IncomingMessage): Promise<string> {
  let body = "";
  let bytes = 0;
  request.setEncoding("utf8");
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > requestBytes) throw new Error("invalid_project_tool_request");
    body += chunk;
  }
  return body;
}

function decodeField(value: string): string {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("invalid_project_tool_request");
  return Buffer.from(value, "base64").toString("utf8");
}

function parseRequest(body: string): ProjectToolRequest {
  const lines = body.endsWith("\n") ? body.slice(0, -1).split("\n") : body.split("\n");
  if (lines[0] !== "issue-pilot-project-tool-v1" || lines.length < 6 || lines.length > 6 + argumentCount) throw new Error("invalid_project_tool_request");
  const [tool, issueKey, repository, project, action, ...args] = lines.slice(1).map(decodeField);
  if ((tool !== "node" && tool !== "maven") || !validWorkspaceName(repository!) || !action || [issueKey!, project!, action, ...args].some((value) => value.length > argumentCharacters || value.includes("\0"))) throw new Error("invalid_project_tool_request");
  return { tool, issueKey: normalizeIssueKey(issueKey!), repository: repository!, project: project!, action, args };
}

async function socketActive(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      operation();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("project_tool_socket_probe_timeout"))), 1_000);
    timer.unref();
    socket.once("connect", () => finish(() => resolve(true)));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") finish(() => resolve(false));
      else finish(() => reject(error));
    });
  });
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const metadata = await lstat(socketPath);
    if (!metadata.isSocket()) throw new Error("project_tool_socket_invalid");
    if (await socketActive(socketPath)) throw new Error("project_tool_broker_already_running");
    await rm(socketPath);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
}

export class ProjectToolBroker {
  readonly socketPath: string;
  private readonly queue = new KeyedSerialQueue();
  private readonly database: Database;
  private readonly stateRoot: string;
  private readonly tools: ToolRuntime;
  private readonly runtime: ProjectToolRuntime;
  private readonly reporter: (error: unknown) => void;
  private server: Server | undefined;
  private socketIdentity: { dev: bigint; ino: bigint } | undefined;
  private closing = false;

  constructor(
    database: Database,
    stateRoot: string,
    tools: ToolRuntime = processToolRuntime,
    runtime: ProjectToolRuntime = issuePilotConfig.runtime.projectTools,
    reporter: (error: unknown) => void = () => undefined,
  ) {
    this.database = database;
    this.stateRoot = path.resolve(stateRoot);
    this.tools = tools;
    this.runtime = runtime;
    this.reporter = reporter;
    this.socketPath = path.join(this.stateRoot, "control", "project-tools.sock");
  }

  async start(): Promise<void> {
    if (this.server) return;
    const controlRoot = path.dirname(this.socketPath);
    await mkdir(controlRoot, { recursive: true, mode: 0o700 });
    await chmod(controlRoot, 0o700);
    await removeStaleSocket(this.socketPath);
    this.closing = false;
    const server = createServer((request, response) => { void this.handle(request, response); });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
        const onListening = () => { server.off("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.socketPath);
      });
      const socketMetadata = await lstat(this.socketPath, { bigint: true });
      this.socketIdentity = { dev: socketMetadata.dev, ino: socketMetadata.ino };
      await chmod(this.socketPath, 0o600);
    } catch (error) {
      this.server = undefined;
      server.close();
      await this.removeOwnedSocket().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await this.queue.idle();
    await this.removeOwnedSocket();
  }

  private async removeOwnedSocket(): Promise<void> {
    const identity = this.socketIdentity;
    this.socketIdentity = undefined;
    if (!identity) return;
    try {
      const metadata = await lstat(this.socketPath, { bigint: true });
      if (metadata.isSocket() && metadata.dev === identity.dev && metadata.ino === identity.ino) await rm(this.socketPath);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
  }

  async run(input: ProjectToolRequest, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number }> {
    if (this.closing) throw new Error("project_tool_broker_closed");
    const issueKey = normalizeIssueKey(input.issueKey);
    return this.queue.run(issueKey, async () => {
      const [issue] = await this.database.select({ id: issues.id, key: issues.key, type: issues.type, environmentKind: environments.kind })
        .from(issues).innerJoin(environments, eq(environments.id, issues.environmentId)).where(eq(issues.key, issueKey)).limit(1);
      if (!issue) throw new Error("issue_not_found");
      if (issue.environmentKind !== "dev" || !ISSUE_TYPES_BY_ENVIRONMENT.dev.includes(issue.type as "defect_fix" | "feature_development")) throw new Error("workspace_not_development");
      const repositories = await this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
      if (classifyRepositoryState(repositories) !== "development_workspace") throw new Error("development_repository_state_invalid");
      const repository = repositories.find((candidate) => candidate.workspaceName === input.repository);
      if (!repository?.localPath) throw new Error("workspace_repository_missing");
      const expectedRepository = path.join(issueWorkspaceRoot(this.stateRoot, issueKey), input.repository);
      if (path.resolve(repository.localPath) !== expectedRepository || await realpath(expectedRepository) !== expectedRepository) throw new Error("workspace_path_does_not_match_repository");
      const relativeProject = projectRelativePath(input.project);
      const project = path.resolve(expectedRepository, relativeProject);
      const relativeToRepository = path.relative(expectedRepository, project);
      if (relativeToRepository.startsWith("..") || path.isAbsolute(relativeToRepository) || await realpath(project) !== project) throw new Error("project_outside_issue_workspace");
      const command = input.tool === "node"
        ? await this.nodeCommand(project, input.action, input.args)
        : await this.mavenCommand(project, input.action, input.args);
      const execution = await this.tools.run({
        command: command.args,
        cwd: project,
        environment: { CI: "1", ...command.environment },
      }, { timeout: this.runtime.executionMs, ...(signal ? { signal } : {}) });
      return execution;
    });
  }

  private async nodeCommand(project: string, action: string, args: string[]): Promise<{ environment: Record<string, string>; args: string[] }> {
    if (!(NODE_PROJECT_ACTIONS as readonly string[]).includes(action)) throw new Error("invalid_project_tool_action");
    if (args.some((argument) => /^--watch(?:$|[-_=A-Z])/i.test(argument))) throw new Error("invalid_project_tool_argument");
    let packageManifest: { packageManager?: unknown };
    try { packageManifest = JSON.parse(await readFile(path.join(project, "package.json"), "utf8")) as { packageManager?: unknown }; }
    catch { throw new Error("project_manifest_not_found"); }
    const packageManager = typeof packageManifest.packageManager === "string" ? packageManifest.packageManager : "npm";
    let command: string[];
    if (action === "install") {
      if (packageManager === "npm" || packageManager.startsWith("npm@")) {
        let locked = true;
        try { await stat(path.join(project, "package-lock.json")); } catch { locked = false; }
        command = ["npm", locked ? "ci" : "install", ...args];
      } else throw new Error("unsupported_package_manager");
    } else command = ["npm", "run", action, "--", ...args];
    const npmConfig = await secureFile(resolveOperatorPath(this.runtime.node.npmConfig));
    const npmCache = await secureDirectory(resolveOperatorPath(this.runtime.node.npmCache));
    return {
      environment: { NPM_CONFIG_USERCONFIG: npmConfig, NPM_CONFIG_CACHE: npmCache },
      args: command,
    };
  }

  private async mavenCommand(project: string, action: string, args: string[]): Promise<{ environment: Record<string, string>; args: string[] }> {
    if (!(MAVEN_PROJECT_ACTIONS as readonly string[]).includes(action)) throw new Error("invalid_project_tool_action");
    try {
      const metadata = await stat(path.join(project, "pom.xml"));
      if (!metadata.isFile()) throw new Error("project_manifest_not_found");
    } catch { throw new Error("project_manifest_not_found"); }
    const settings = await secureFile(resolveOperatorPath(this.runtime.maven.settings));
    const repository = await secureDirectory(resolveOperatorPath(this.runtime.maven.repository));
    return {
      environment: {},
      args: ["mvn", "--batch-mode", "--no-transfer-progress", "--settings", settings, `-Dmaven.repo.local=${repository}`, action, ...args],
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    if (this.closing) { response.writeHead(503); response.end("project tool broker is closing\n"); return; }
    if (request.method !== "POST" || request.url !== "/v1/project-tools" || request.headers["content-type"] !== "application/vnd.issue-pilot.project-tool") {
      response.writeHead(404); response.end("project tool endpoint not found\n"); return;
    }
    const abort = new AbortController();
    request.once("aborted", () => abort.abort());
    try {
      const input = parseRequest(await requestBody(request));
      const result = await this.run(input, abort.signal);
      response.writeHead(result.code === 0 ? 200 : 422);
      response.end(`${result.stdout}${result.stderr}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "project_tool_failed";
      if (!stableRequestErrors.has(message)) this.reporter(error);
      response.writeHead(stableRequestErrors.has(message) ? 400 : 500);
      response.end(`${stableRequestErrors.has(message) ? message : "project_tool_failed"}\n`);
    }
  }
}
