import { access } from "node:fs/promises";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { result } from "./output.ts";

const NODE_ACTIONS: Record<string, string[]> = {
  install: ["npm", "ci"],
  test: ["npm", "run", "test"],
  build: ["npm", "run", "build"],
  typecheck: ["npm", "run", "typecheck"],
};
const MAVEN_ACTIONS: Record<string, string[]> = {
  test: ["mvn", "--batch-mode", "--no-transfer-progress", "-Dmaven.repo.local=/tool-cache", "test"],
  verify: ["mvn", "--batch-mode", "--no-transfer-progress", "-Dmaven.repo.local=/tool-cache", "verify"],
  package: ["mvn", "--batch-mode", "--no-transfer-progress", "-Dmaven.repo.local=/tool-cache", "package"],
};

function project(cwd: string, requested: string, marker: string): { host: string; container: string; issueRoot: string } {
  const issueRoot = path.resolve(cwd);
  if (!/^issue-(?:[0-9]{4,}|[0-9]{8}-[0-9]{3,4})$/.test(path.basename(issueRoot).toLowerCase())) throw new Error("issue_workspace_container_not_available");
  const host = path.resolve(issueRoot, requested);
  const relative = path.relative(issueRoot, host);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("project_path_outside_issue_workspace");
  return { host, container: `/workspaces/${path.basename(issueRoot)}/${relative.split(path.sep).join("/")}`, issueRoot };
}

async function run(pi: ExtensionAPI, cwd: string, input: { project_path: string; action: string }, kind: "node" | "maven", signal?: AbortSignal) {
  const definition = project(cwd, input.project_path, kind === "node" ? "package.json" : "pom.xml");
  await access(path.join(definition.host, kind === "node" ? "package.json" : "pom.xml"));
  const command = (kind === "node" ? NODE_ACTIONS : MAVEN_ACTIONS)[input.action];
  if (!command) throw new Error("unsupported_project_action");
  const workspaceContainer = `/workspaces/${path.basename(definition.issueRoot)}`;
  const args = [
    "run", "--rm", "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--network", "none",
    "--volume", `${definition.issueRoot}:${workspaceContainer}:Z`, "--workdir", definition.container,
  ];
  if (kind === "maven") args.push("--volume", `${path.resolve(process.env.PI_TOOL_CACHE_ROOT ?? ".issue-pilot/tool-cache")}/maven:/tool-cache:Z`);
  args.push(kind === "node" ? (process.env.PI_NODE_CLI_IMAGE ?? "docker.io/library/node:26.5.1-bookworm-slim") : (process.env.PI_MAVEN_CLI_IMAGE ?? "docker.io/library/maven:3.9.16-eclipse-temurin-8"), ...command);
  const execution = await pi.exec("podman", args, { timeout: 10 * 60_000, ...(signal ? { signal } : {}) });
  return result({ runtime: "container", action: input.action, exitCode: execution.code, stdout: execution.stdout, stderr: execution.stderr }, { kind, action: input.action });
}

export function runNodeProject(pi: ExtensionAPI, cwd: string, input: { project_path: string; action: string }, signal?: AbortSignal) {
  return run(pi, cwd, input, "node", signal);
}

export function runMavenProject(pi: ExtensionAPI, cwd: string, input: { project_path: string; action: string }, signal?: AbortSignal) {
  return run(pi, cwd, input, "maven", signal);
}
