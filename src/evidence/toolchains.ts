import { access, cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { grantedProject, type IssuePolicy } from "../pi/policy.ts";

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

async function run(pi: ExtensionAPI, policy: IssuePolicy, cwd: string, input: { project_path: string; action: string }, kind: "node" | "maven", signal?: AbortSignal) {
  const definition = await grantedProject(policy, cwd, input.project_path);
  const marker = kind === "node" ? "package.json" : "pom.xml";
  await access(path.join(definition.projectPath, marker));
  const command = (kind === "node" ? NODE_ACTIONS : MAVEN_ACTIONS)[input.action];
  if (!command) throw new Error("unsupported_project_action");

  const snapshotRoot = await mkdtemp(path.join(os.tmpdir(), `issue-pilot-${kind}-`));
  const snapshotRepository = path.join(snapshotRoot, "repository");
  try {
    await cp(definition.repositoryPath, snapshotRepository, {
      recursive: true,
      filter(source) {
        const relative = path.relative(definition.repositoryPath, source);
        const first = relative.split(path.sep)[0];
        return first !== ".git" && first !== "target" && first !== "dist";
      },
    });
    const projectRelative = path.relative(definition.repositoryPath, definition.projectPath).split(path.sep).join("/");
    const workdir = projectRelative ? `/workspace/${projectRelative}` : "/workspace";
    const args = [
      "run", "--rm", "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--network", "none",
      "--volume", `${snapshotRepository}:/workspace:Z`, "--workdir", workdir,
    ];
    if (kind === "maven") args.push("--volume", `${path.resolve(process.env.PI_TOOL_CACHE_ROOT ?? ".issue-pilot/tool-cache")}/maven/${policy.issueKey.toLowerCase()}:/tool-cache:Z`);
    args.push(kind === "node" ? (process.env.PI_NODE_CLI_IMAGE ?? "docker.io/library/node:26.5.1-bookworm-slim") : (process.env.PI_MAVEN_CLI_IMAGE ?? "docker.io/library/maven:3.9.16-eclipse-temurin-8"), ...command);
    const execution = await pi.exec("podman", args, { timeout: 10 * 60_000, ...(signal ? { signal } : {}) });
    const output = { runtime: "container", isolation: "ephemeral-copy", action: input.action, exitCode: execution.code, stdout: execution.stdout, stderr: execution.stderr };
    return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }], details: { kind, action: input.action } };
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true });
  }
}

export function runNodeProject(pi: ExtensionAPI, policy: IssuePolicy, cwd: string, input: { project_path: string; action: string }, signal?: AbortSignal) {
  return run(pi, policy, cwd, input, "node", signal);
}

export function runMavenProject(pi: ExtensionAPI, policy: IssuePolicy, cwd: string, input: { project_path: string; action: string }, signal?: AbortSignal) {
  return run(pi, policy, cwd, input, "maven", signal);
}
