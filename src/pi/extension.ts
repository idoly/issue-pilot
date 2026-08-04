import { appendFile } from "node:fs/promises";
import path from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { readConfiguration, readDatabase } from "../evidence/capabilities.ts";
import { runMavenProject, runNodeProject } from "../evidence/toolchains.ts";
import {
  assertToolGranted,
  authorizeWorkspacePath,
  grantedServices,
  loadIssuePolicy,
  type PolicyToolName,
} from "./policy.ts";
import { repositoryStatus } from "./repository.ts";

const PATH_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"]);
const WRITE_TOOLS = new Set(["edit", "write"]);

function requestedServiceKey(policy: Awaited<ReturnType<typeof loadIssuePolicy>>, requested: unknown): string {
  if (typeof requested === "string" && requested.trim()) return requested.trim();
  const serviceKeys = [...new Set(policy.services.map((service) => service.serviceKey))];
  if (serviceKeys.length !== 1) throw new Error("service_key_required_for_multi_service_issue");
  return serviceKeys[0]!;
}

export default function issuePilotExtension(pi: ExtensionAPI): void {
  if (process.env.ISSUE_PILOT_POLICY_REQUIRED !== "1") return;

  pi.on("project_trust", () => ({ trusted: "no", remember: false }));

  pi.on("session_start", async (_event, context) => {
    const policy = await loadIssuePolicy(context.cwd);
    pi.setActiveTools(policy.tools);
    context.ui.setStatus("issue-policy", `${policy.issueKey} · ${policy.issueType} · ${policy.tools.length} tools`);
  });

  pi.on("session_shutdown", (_event, context) => {
    context.ui.setStatus("issue-policy", undefined);
  });

  pi.on("session_before_switch", () => ({ cancel: true }));
  pi.on("session_before_fork", () => ({ cancel: true }));

  pi.on("before_agent_start", async (event, context) => {
    const policy = await loadIssuePolicy(context.cwd);
    const writable = policy.tools.includes("write");
    const writableRepositories = policy.services.filter((service) => service.codeAccess === "write").length;
    return {
      systemPrompt: [
        event.systemPrompt,
        "",
        "Issue Pilot execution policy:",
        `- Bound issue: ${policy.issueKey} (${policy.issueType}).`,
        `- Active tools: ${policy.tools.join(", ")}.`,
        `- Repository access is restricted to ${policy.services.length} repository scope(s); ${writableRepositories} permit mutation when the issue type allows it.`,
        `- Code mutation is ${writable ? "allowed only in explicitly granted repository roots" : "disabled for this issue type"}.`,
        "- Arbitrary shell execution, remote pushes, project-local extensions, and session switching are disabled.",
        "- External systems and build runtimes must be accessed only through the registered Issue Pilot tools.",
        "- Call external capability tools only when the current investigation needs that evidence; an active tool is available, not pre-executed.",
        "- When the user asks for current, effective, or environment-specific application configuration, call configuration_read. It resolves frozen repository files and approved Nacos imports; do not answer from a YAML file alone.",
        "- For database evidence, call database_read with the relevant service key. It resolves that service's repositories, frozen configuration, Nacos imports, and datasource before running the bounded read-only query.",
      ].join("\n"),
    };
  });

  pi.on("tool_call", async (event, context) => {
    const policy = await loadIssuePolicy(context.cwd);
    assertToolGranted(policy, event.toolName);
    if (!PATH_TOOLS.has(event.toolName)) return;
    const input = event.input as { path?: unknown };
    const requestedPath = typeof input.path === "string" ? input.path : ".";
    await authorizeWorkspacePath(policy, context.cwd, requestedPath, WRITE_TOOLS.has(event.toolName) ? "write" : "read");
  });

  pi.on("user_bash", () => ({
    result: {
      output: "Arbitrary shell commands are disabled by the issue policy. Use an approved Issue Pilot tool.",
      exitCode: 126,
      cancelled: false,
      truncated: false,
    },
  }));

  pi.on("agent_settled", async () => {
    const signalFile = process.env.ISSUE_PILOT_SETTLED_SIGNAL_FILE;
    if (!signalFile || !path.isAbsolute(signalFile)) return;
    await appendFile(signalFile, `${Date.now()}\n`, { encoding: "utf8", mode: 0o600 });
  });

  pi.registerTool({
    name: "configuration_read",
    label: "Read Service Configuration",
    description: "On demand, inspect every repository granted to a service and return sanitized configuration resolved from frozen files and approved Nacos providers.",
    parameters: Type.Object({ service_key: Type.Optional(Type.String({ description: "Service key. May be omitted only when the issue selects exactly one service." })) }),
    async execute(_id, raw, signal, _update, context) {
      const input = raw as { service_key?: string };
      const policy = await loadIssuePolicy(context.cwd);
      assertToolGranted(policy, "configuration_read");
      const serviceKey = requestedServiceKey(policy, input.service_key);
      return readConfiguration(pi, grantedServices(policy, serviceKey, "configuration_read"), signal);
    },
  });

  pi.registerTool({
    name: "database_read",
    label: "Run Read-Only Database Query",
    description: "On demand, find the granted service repositories, resolve frozen configuration and approved Nacos imports, locate one datasource, and run one bounded read-only SQL statement. SELECT statements must include LIMIT 1-1000.",
    parameters: Type.Object({
      service_key: Type.String(),
      statement: Type.String({ maxLength: 20_000 }),
    }),
    async execute(_id, raw, signal, _update, context) {
      const input = raw as { service_key: string; statement: string };
      const policy = await loadIssuePolicy(context.cwd);
      assertToolGranted(policy, "database_read");
      return readDatabase(pi, context.cwd, grantedServices(policy, input.service_key, "database_read"), input, signal);
    },
  });

  pi.registerTool({
    name: "node_project_command",
    label: "Run Node Project Action",
    description: "Run a fixed Node project action in a pinned disposable container with no network.",
    parameters: Type.Object({
      project_path: Type.String(),
      action: StringEnum(["install", "test", "build", "typecheck"] as const),
    }),
    async execute(_id, raw, signal, _update, context) {
      const policy = await loadIssuePolicy(context.cwd);
      assertToolGranted(policy, "node_project_command");
      return runNodeProject(pi, policy, context.cwd, raw as { project_path: string; action: string }, signal);
    },
  });

  pi.registerTool({
    name: "maven_project_command",
    label: "Run Maven Project Action",
    description: "Run a fixed Maven action in a pinned disposable Java 8 container with no network.",
    parameters: Type.Object({
      project_path: Type.String(),
      action: StringEnum(["test", "verify", "package"] as const),
    }),
    async execute(_id, raw, signal, _update, context) {
      const policy = await loadIssuePolicy(context.cwd);
      assertToolGranted(policy, "maven_project_command");
      return runMavenProject(pi, policy, context.cwd, raw as { project_path: string; action: string }, signal);
    },
  });

  pi.registerTool({
    name: "repository_status",
    label: "Inspect Repository Changes",
    description: "On demand, show status or diff for every repository granted to one service without allowing arbitrary git commands.",
    parameters: Type.Object({
      service_key: Type.String(),
      action: StringEnum(["status", "diff"] as const),
    }),
    async execute(_id, raw, signal, _update, context) {
      const input = raw as { service_key: string; action: "status" | "diff" };
      const policy = await loadIssuePolicy(context.cwd);
      assertToolGranted(policy, "repository_status");
      return repositoryStatus(pi, grantedServices(policy, input.service_key), input.action, signal);
    },
  });
}

export const managedToolNames: readonly PolicyToolName[] = [
  "read", "grep", "find", "ls", "edit", "write", "configuration_read", "database_read",
  "node_project_command", "maven_project_command", "repository_status",
];
