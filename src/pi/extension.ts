import { StringEnum } from "@earendil-works/pi-ai";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { readConfiguration, readDatabase } from "../evidence/capabilities.ts";
import { useBrowser, type BrowserAction } from "../evidence/browser.ts";
import { readAttachment } from "./attachment.ts";
import { readSlsLogs } from "../evidence/sls.ts";
import { readElasticsearch, readRabbitMq, readRedis } from "../evidence/external.ts";
import { runMavenProject, runNodeProject } from "../evidence/toolchains.ts";
import {
  assertSlsGranted,
  assertToolGranted,
  authorizeWorkspacePath,
  grantedRepositories,
  type IssuePolicy,
} from "./policy.ts";
import { repositoryStatus } from "./repository.ts";

const PATH_TOOLS = new Set(["repository_read", "repository_grep", "repository_find", "repository_list", "repository_edit", "repository_write"]);
const WRITE_TOOLS = new Set(["repository_edit", "repository_write"]);
export interface IssueCompletion {
  outcome: "resolved" | "needs_human" | "blocked";
  summary: string;
  rootCause?: string;
  evidence: string[];
  changes: string[];
  verification: string[];
  risks: string[];
}

export interface IssuePilotExtensionOptions {
  policy: IssuePolicy;
  deploymentConfig: Record<string, unknown>;
  onComplete?: (result: IssueCompletion) => Promise<void> | void;
}

export function registerIssuePilotExtension(pi: ExtensionAPI, options: IssuePilotExtensionOptions): void {
  const policy = options.policy;
  const capabilityConfig = (key: "nacos" | "db" | "sls" | "playwright" | "redis" | "es" | "mq") => {
    const value = options.deploymentConfig[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${key}_configuration_not_found`);
    return value as Record<string, unknown>;
  };

  pi.on("project_trust", () => ({ trusted: "no", remember: false }));

  pi.on("session_start", (_event, context) => {
    pi.setActiveTools(policy.tools);
    context.ui.setStatus("issue-policy", `${policy.issueKey} · ${policy.issueType} · ${policy.tools.length} tools`);
  });

  pi.on("session_shutdown", (_event, context) => {
    context.ui.setStatus("issue-policy", undefined);
  });

  pi.on("session_before_switch", () => ({ cancel: true }));
  pi.on("session_before_fork", () => ({ cancel: true }));

  pi.on("before_agent_start", (event) => {
    const writable = policy.tools.includes("repository_write");
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const writableRepositories = policy.service.repositories.filter((repository) => repository.codeAccess === "write").length;
    return {
      systemPrompt: [
        event.systemPrompt,
        "",
        "Issue Pilot execution policy:",
        `- Bound issue: ${policy.issueKey} (${policy.issueType}).`,
        `- Active tools: ${policy.tools.join(", ")}.`,
        `- Repository access is restricted to ${policy.service.repositories.length} repository scope(s); ${writableRepositories} permit mutation when the issue type allows it.`,
        `- Code mutation is ${writable ? "allowed only in explicitly granted repository roots" : "disabled for this issue type"}.`,
        "- Arbitrary shell execution, remote pushes, project-local extensions, and session switching are disabled.",
        "- External systems, attachments, repository files, and build runtimes must be accessed only through the registered Issue Pilot tools.",
        "- Call external capability tools only when the current investigation needs that evidence; an active tool is available, not pre-executed.",
        "- In the final user-facing answer, preserve all capability fields returned by the tool without filtering, redaction, summarization, or reconstruction.",
        "- Before calling complete_issue, prepare the complete user-facing answer, including any records or fields the user requested. After complete_issue records the outcome, provide that final answer; do not leave the response at an introduction such as 'results below'.",
        "- When the user asks for current, effective, or environment-specific application configuration, call nacos. It returns every resolved property from frozen repository files and repository-configured Nacos imports.",
        "- For database evidence, call db. It uses the selected deployment's direct database connection and returns the complete result of one read-only query. In the final answer, present connection fields as labeled lines, URL query parameters one per line, rows as a compact table, and execution metadata last; do not paste the database result as JSON.",
        ...(policy.tools.includes("redis") ? ["- For Redis evidence, call redis with one read-only operation; mutation and arbitrary commands are unavailable."] : []),
        ...(policy.tools.includes("es") ? ["- For Elasticsearch evidence, call es through the selected deployment's REST endpoint and preserve the complete response."] : []),
        ...(policy.tools.includes("mq") ? ["- For RabbitMQ evidence, call mq for management metadata only; never consume, publish, acknowledge, or purge messages."] : []),
        ...(policy.tools.includes("sls") ? [
          "- For application logs, call sls only when it is active. It executes a read-only SLS query through the local Aliyun CLI; never invoke Aliyun CLI through another tool.",
          `- Current SLS reference time is ${now.toISOString()} (${nowSeconds} Unix seconds). For real-time or recent evidence, anchor the newest query window at this time rather than at the issue creation date.`,
          "- Query the full requested SLS time range and preserve every record returned by the service.",
          "- For a trace ID without an explicit event time, call sls with trace_id and omit from/to; the tool will use the current trailing 24-hour window and preserve the complete UUID. Supply from/to only when the user provided an event time or when continuing older contiguous windows. Do not put a trace ID in query or shorten it to a prefix.",
          "- The sls result includes authoritative query metadata and records. Report its actual from/to window, returnedRows, order, and possiblyIncomplete state; never reconstruct the window from an old message.",
          "- SLS ToolExecution displays every returned field directly, including credentials, infrastructure fields, business values, trace IDs, and IDs.",
          "- A trace_id lookup returns matching records, not a guaranteed single distributed trace. If the UUID appears in separated time clusters, different requests, or reused thread context, segment the records and explicitly report trace reuse or contamination.",
          "- SLS records are not application-filtered or truncated; report query metadata exactly as returned.",
          "- Before concluding that logs are absent, verify that the actual from/to Unix timestamps include the event time and summarize the exact covered interval.",
        ] : []),
        ...(policy.tools.includes("playwright") ? [
          `- For browser evidence, playwright is restricted to ${policy.service.browser?.baseUrl}. It returns the complete page text, controls, and optional screenshot.`,
          "- Use only relative paths and declarative actions. Use the login action for configured deployment credentials; credentials are injected inside the container and must never be requested, inferred, or repeated.",
        ] : []),
        ...(policy.attachments.length ? ["- The issue has explicitly granted attachments. Call attachment_read with an attachment ID only when its contents are relevant."] : []),
      ].join("\n"),
    };
  });

  pi.on("tool_call", async (event, context) => {
    assertToolGranted(policy, event.toolName);
    if (!PATH_TOOLS.has(event.toolName)) return;
    const input = event.input as { path?: unknown };
    const requestedPath = typeof input.path === "string" ? input.path : ".";
    await authorizeWorkspacePath(policy, context.cwd, requestedPath, WRITE_TOOLS.has(event.toolName) ? "write" : "read");
  });

  pi.registerTool({ ...createReadToolDefinition(policy.workspaceRoot), name: "repository_read", label: "Read Repository File", promptGuidelines: ["Use repository_read to examine granted repository files."] });
  pi.registerTool({ ...createGrepToolDefinition(policy.workspaceRoot), name: "repository_grep", label: "Search Repository Text" });
  pi.registerTool({ ...createFindToolDefinition(policy.workspaceRoot), name: "repository_find", label: "Find Repository Files" });
  pi.registerTool({ ...createLsToolDefinition(policy.workspaceRoot), name: "repository_list", label: "List Repository Directory" });
  pi.registerTool({ ...createEditToolDefinition(policy.workspaceRoot), name: "repository_edit", label: "Edit Repository File", promptGuidelines: ["Use repository_edit for precise changes in granted writable repository files; edits[].oldText must match exactly."] });
  pi.registerTool({ ...createWriteToolDefinition(policy.workspaceRoot), name: "repository_write", label: "Write Repository File", promptGuidelines: ["Use repository_write only for new files or complete rewrites in granted writable repositories."] });

  pi.on("user_bash", () => ({
    result: {
      output: "Arbitrary shell commands are disabled by the issue policy. Use an approved Issue Pilot tool.",
      exitCode: 126,
      cancelled: false,
      truncated: false,
    },
  }));

  pi.registerTool({
    name: "attachment_read",
    label: "Read Issue Attachment",
    description: "Read one explicitly granted issue attachment by ID. Returns complete UTF-8 text or PNG, JPEG, WebP, and GIF image data.",
    parameters: Type.Object({ attachment_id: Type.String() }),
    async execute(_id, raw) {
      assertToolGranted(policy, "attachment_read");
      return readAttachment(policy, (raw as { attachment_id: string }).attachment_id);
    },
  });

  pi.registerTool({
    name: "nacos",
    label: "Read Service Configuration",
    description: "Return all effective configuration resolved from frozen repository files and repository-configured Nacos imports without filtering fields.",
    parameters: Type.Object({}),
    async execute(_id, _raw, signal) {
      assertToolGranted(policy, "nacos");
      const grant = policy.service.nacos;
      if (!grant) throw new Error("nacos_scope_not_granted_for_service");
      const controlledConfiguration = options.deploymentConfig;
      const nacos = capabilityConfig("nacos");
      if (nacos.serverUrl !== grant.serverUrl || nacos.namespace !== grant.namespace || nacos.group !== grant.group || typeof nacos.username !== "string" || (nacos.password !== undefined && typeof nacos.password !== "string")) throw new Error("nacos_configuration_changed");
      return readConfiguration(pi, grantedRepositories(policy, "nacos"), controlledConfiguration, signal, { serverUrl: grant.serverUrl, namespace: grant.namespace, group: grant.group, username: nacos.username, password: typeof nacos.password === "string" ? nacos.password : "" });
    },
  });

  pi.registerTool({
    name: "db",
    label: "Run Read-Only Database Query",
    description: "Run one read-only SQL statement and return the complete controlled connection configuration, including password, plus every row and column produced by the selected deployment database.",
    parameters: Type.Object({
      statement: Type.String({ maxLength: 20_000 }),
    }),
    async execute(_id, raw, signal, _update, context) {
      const input = raw as { statement: string };
      assertToolGranted(policy, "db");
      return readDatabase(pi, policy, capabilityConfig("db"), context.cwd, input, signal);
    },
  });

  pi.registerTool({
    name: "sls",
    label: "Read SLS Logs",
    description: "Run one immediate, read-only Simple Log Service query and return every field in every record returned by the local Aliyun CLI.",
    parameters: Type.Object({
      project: Type.String({ maxLength: 63 }),
      logstore: Type.String({ maxLength: 63 }),
      from: Type.Optional(Type.Integer({ minimum: 0 })),
      to: Type.Optional(Type.Integer({ minimum: 1 })),
      query: Type.Optional(Type.String({ maxLength: 4096 })),
      trace_id: Type.Optional(Type.String({ maxLength: 36 })),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_id, raw, signal) {
      const input = raw as { project: string; logstore: string; from?: number; to?: number; query?: string; trace_id?: string; limit?: number };
      assertSlsGranted(policy, input.project, input.logstore);
      return readSlsLogs(pi, policy, input, capabilityConfig("sls"), signal);
    },
  });

  pi.registerTool({
    name: "redis",
    label: "Read Redis",
    description: "Run one read-only Redis operation and return its complete response.",
    parameters: Type.Object({
      action: StringEnum(["get", "mget", "hget", "hgetall", "type", "ttl", "scan"] as const),
      key: Type.Optional(Type.String({ maxLength: 1024 })),
      keys: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }))),
      field: Type.Optional(Type.String({ maxLength: 1024 })),
      pattern: Type.Optional(Type.String({ maxLength: 1024 })),
      cursor: Type.Optional(Type.String({ maxLength: 30 })),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_id, raw, signal, _update, context) {
      assertToolGranted(policy, "redis");
      return readRedis(pi, policy, capabilityConfig("redis"), context.cwd, raw as Parameters<typeof readRedis>[4], signal);
    },
  });

  pi.registerTool({
    name: "es",
    label: "Read Elasticsearch",
    description: "Run one cluster-level search, count, or mapping request and return the complete Elasticsearch response.",
    parameters: Type.Object({
      action: StringEnum(["search", "count", "mapping"] as const),
      query: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_id, raw, signal, _update, context) {
      assertToolGranted(policy, "es");
      return readElasticsearch(pi, policy, capabilityConfig("es"), context.cwd, raw as Parameters<typeof readElasticsearch>[4], signal);
    },
  });

  pi.registerTool({
    name: "mq",
    label: "Read RabbitMQ",
    description: "Return complete RabbitMQ management overview, queue listings, queue metadata, or bindings without consuming messages.",
    parameters: Type.Object({
      action: StringEnum(["overview", "queues", "queue", "bindings"] as const),
      queue: Type.Optional(Type.String({ maxLength: 255 })),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_id, raw, signal, _update, context) {
      assertToolGranted(policy, "mq");
      return readRabbitMq(pi, policy, capabilityConfig("mq"), context.cwd, raw as Parameters<typeof readRabbitMq>[4], signal);
    },
  });

  pi.registerTool({
    name: "playwright",
    label: "Use Service Browser",
    description: "Run declarative browser actions against the selected deployment and return complete page text, controls, and an optional screenshot.",
    parameters: Type.Object({
      actions: Type.Array(Type.Union([
        Type.Object({ type: Type.Literal("goto"), path: Type.String({ maxLength: 2048 }) }),
        Type.Object({ type: Type.Literal("login"), username_selector: Type.String({ maxLength: 500 }), password_selector: Type.String({ maxLength: 500 }), submit_selector: Type.String({ maxLength: 500 }) }),
        Type.Object({ type: Type.Literal("click"), selector: Type.String({ maxLength: 500 }) }),
        Type.Object({ type: Type.Literal("fill"), selector: Type.String({ maxLength: 500 }), value: Type.String({ maxLength: 10_000 }) }),
        Type.Object({ type: Type.Literal("select"), selector: Type.String({ maxLength: 500 }), value: Type.String({ maxLength: 10_000 }) }),
        Type.Object({ type: Type.Literal("wait_for"), selector: Type.String({ maxLength: 500 }) }),
      ]), { minItems: 1 }),
      screenshot: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, raw, signal) {
      assertToolGranted(policy, "playwright");
      const input = raw as { actions: Array<Record<string, unknown>>; screenshot?: boolean };
      const actions = input.actions.map((action): BrowserAction => action.type === "login" ? {
        type: "login",
        usernameSelector: String(action.username_selector),
        passwordSelector: String(action.password_selector),
        submitSelector: String(action.submit_selector),
      } : action as BrowserAction);
      return useBrowser(pi, policy, options.deploymentConfig, { actions, ...(input.screenshot !== undefined ? { screenshot: input.screenshot } : {}) }, signal);
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
      assertToolGranted(policy, "maven_project_command");
      return runMavenProject(pi, policy, context.cwd, raw as { project_path: string; action: string }, signal);
    },
  });

  pi.registerTool({
    name: "repository_status",
    label: "Inspect Repository Changes",
    description: "On demand, show status or diff for every repository granted to one service without allowing arbitrary git commands.",
    parameters: Type.Object({
      action: StringEnum(["status", "diff"] as const),
    }),
    async execute(_id, raw, signal) {
      const input = raw as { action: "status" | "diff" };
      assertToolGranted(policy, "repository_status");
      return repositoryStatus(pi, grantedRepositories(policy), input.action, signal);
    },
  });

  pi.registerTool({
    name: "complete_issue",
    label: "Complete Issue Run",
    description: "Submit the structured outcome after investigation, implementation, and verification are complete. After this tool records the outcome, provide one complete final user-facing answer containing the requested results or an explicit empty/blocked explanation. Do not call complete_issue again in the same run.",
    parameters: Type.Object({
      outcome: StringEnum(["resolved", "needs_human", "blocked"] as const),
      summary: Type.String({ minLength: 1, maxLength: 10_000 }),
      root_cause: Type.Optional(Type.String({ maxLength: 10_000 })),
      evidence: Type.Array(Type.String()),
      changes: Type.Array(Type.String()),
      verification: Type.Array(Type.String()),
      risks: Type.Array(Type.String()),
    }),
    async execute(_id, raw) {
      const input = raw as { outcome: IssueCompletion["outcome"]; summary: string; root_cause?: string; evidence: string[]; changes: string[]; verification: string[]; risks: string[] };
      assertToolGranted(policy, "complete_issue");
      if (input.outcome === "resolved" && input.verification.length === 0) throw new Error("issue_completion_requires_verification");
      if (policy.service.environmentKind !== "development" && input.changes.length > 0) throw new Error("read_only_environment_cannot_report_code_changes");
      const completion: IssueCompletion = {
        outcome: input.outcome,
        summary: input.summary,
        ...(input.root_cause ? { rootCause: input.root_cause } : {}),
        evidence: input.evidence,
        changes: input.changes,
        verification: input.verification,
        risks: input.risks,
      };
      await options.onComplete?.(completion);
      return {
        content: [{ type: "text" as const, text: `Issue outcome submitted: ${completion.outcome}. Now provide the complete final user-facing answer, including the actual requested records or fields when applicable. Do not call complete_issue again.` }],
        details: completion,
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("complete_issue")), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const completion = result.details as IssueCompletion | undefined;
      if (!completion) return new Text(theme.fg("error", "Invalid completion result"), 0, 0);
      const color = completion.outcome === "resolved" ? "success" : completion.outcome === "blocked" ? "error" : "warning";
      const lines = [theme.fg(color, theme.bold(completion.outcome)), completion.summary];
      if (expanded) {
        if (completion.rootCause) lines.push(`Root cause: ${completion.rootCause}`);
        if (completion.verification.length) lines.push(`Verification: ${completion.verification.join("; ")}`);
        if (completion.risks.length) lines.push(`Risks: ${completion.risks.join("; ")}`);
      }
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
