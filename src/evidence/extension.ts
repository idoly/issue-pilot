import { appendFile } from "node:fs/promises";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { readConfiguration, readDatabase } from "./capabilities.ts";
import { grantedService, loadIssueCapabilities } from "./grants.ts";
import { runMavenProject, runNodeProject } from "./toolchains.ts";

export default function evidenceExtension(pi: ExtensionAPI): void {
  pi.on("agent_settled", async () => {
    const signalFile = process.env.ISSUE_PILOT_SETTLED_SIGNAL_FILE;
    if (!signalFile || !path.isAbsolute(signalFile)) return;
    await appendFile(signalFile, `${Date.now()}\n`, { encoding: "utf8", mode: 0o600 });
  });

  pi.registerTool({
    name: "configuration_read",
    label: "Read Service Configuration",
    description: "Read sanitized configuration from the frozen service revision and approved configuration providers.",
    parameters: Type.Object({ service_key: Type.String() }),
    async execute(_id, raw, signal, _update, context) {
      const input = raw as { service_key: string };
      const grants = await loadIssueCapabilities(context.cwd);
      return readConfiguration(pi, grantedService(grants, input.service_key, "configuration_read"), signal);
    },
  });

  pi.registerTool({
    name: "database_read",
    label: "Run Read-Only Database Query",
    description: "Run one issue-relevant read-only SQL statement against the granted service and environment database. SELECT statements must include LIMIT 1-1000.",
    parameters: Type.Object({
      service_key: Type.String(),
      statement: Type.String({ maxLength: 20_000 }),
    }),
    async execute(_id, raw, signal, _update, context) {
      const input = raw as { service_key: string; statement: string };
      const grants = await loadIssueCapabilities(context.cwd);
      const service = grantedService(grants, input.service_key, "database_read");
      return readDatabase(pi, context.cwd, service, input, signal);
    },
  });

  pi.registerTool({
    name: "node_project_command",
    label: "Run Node Project Action",
    description: "Run a fixed Node project action in a pinned disposable container.",
    parameters: Type.Object({
      project_path: Type.String(),
      action: Type.Union([Type.Literal("install"), Type.Literal("test"), Type.Literal("build"), Type.Literal("typecheck")]),
    }),
    execute(_id, raw, signal, _update, context) {
      return runNodeProject(pi, context.cwd, raw as { project_path: string; action: string }, signal);
    },
  });

  pi.registerTool({
    name: "maven_project_command",
    label: "Run Maven Project Action",
    description: "Run a fixed Maven action in a pinned disposable Java 8 container.",
    parameters: Type.Object({
      project_path: Type.String(),
      action: Type.Union([Type.Literal("test"), Type.Literal("verify"), Type.Literal("package")]),
    }),
    execute(_id, raw, signal, _update, context) {
      return runMavenProject(pi, context.cwd, raw as { project_path: string; action: string }, signal);
    },
  });
}
