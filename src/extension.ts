import { resolve } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { AliyunEvidenceConnector } from "./aliyun-connectors.ts";
import { dingTalkNotifierFromEnvironment } from "./dingtalk.ts";
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  ISSUE_TYPES,
  IssueStore,
  type Issue,
  type IssuePriority,
  type IssueStatus,
  type IssueType,
} from "./store.ts";

const stores = new Map<string, IssueStore>();
let connectorPromise: Promise<AliyunEvidenceConnector> | undefined;

function getConnector(): Promise<AliyunEvidenceConnector> {
  const filePath = process.env.ISSUE_AGENT_CONNECTORS_FILE;
  if (!filePath) throw new Error("ISSUE_AGENT_CONNECTORS_FILE is not configured");
  connectorPromise ??= AliyunEvidenceConnector.fromFile(filePath);
  return connectorPromise;
}

function getStore(cwd: string): IssueStore {
  const configured = process.env.ISSUE_AGENT_DATA_FILE;
  const filePath = configured
    ? resolve(cwd, configured)
    : resolve(cwd, ".issue-agent", "issues.json");
  let store = stores.get(filePath);
  if (!store) {
    store = new IssueStore(filePath);
    stores.set(filePath, store);
  }
  return store;
}

function summarize(issue: Issue): string {
  const owner = issue.assignee ?? "unassigned";
  return `${issue.id} [${issue.priority}/${issue.status}] ${issue.title} (${owner})`;
}

function issueText(issue: Issue): string {
  return JSON.stringify(issue, null, 2);
}

function textResult(text: string, details: unknown = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function issueRenderer(action: string) {
  return (args: object, theme: Theme) => {
    const values = args as Record<string, unknown>;
    const id = typeof values.id === "string" ? ` ${theme.fg("accent", values.id)}` : "";
    return new Text(
      theme.fg("toolTitle", theme.bold("issue ")) + theme.fg("muted", action) + id,
      0,
      0,
    );
  };
}

export default function issueAgentExtension(pi: ExtensionAPI) {
  const notifier = dingTalkNotifierFromEnvironment();
  const notifiedIssues = new Set<string>();

  pi.registerEntryRenderer<{ title: string; lines: string[] }>("issue-agent-list", (entry, _options, theme) => {
    const data = entry.data ?? { title: "Issues", lines: [] };
    const body = data.lines.length ? data.lines.join("\n") : "No matching issues";
    return new Text(`${theme.fg("accent", theme.bold(data.title))}\n${theme.fg("muted", body)}`, 1, 0);
  });

  pi.registerTool({
    name: "issue_create",
    label: "Create Issue",
    description: "Create a persistent issue with title, description, priority, type, ownership, reporter, and labels.",
    promptSnippet: "Create a tracked support or engineering issue",
    promptGuidelines: [
      "Use issue_create only after checking issue_search when the request may duplicate an existing issue.",
      "Use p0 only for an active critical outage or severe security incident; use p1 for major degradation.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Short, specific issue title" }),
      description: Type.Optional(Type.String({ description: "Symptoms, impact, evidence, and acceptance criteria" })),
      priority: Type.Optional(StringEnum(ISSUE_PRIORITIES)),
      type: Type.Optional(StringEnum(ISSUE_TYPES)),
      assignee: Type.Optional(Type.String()),
      reporter: Type.Optional(Type.String()),
      labels: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("issue creation cancelled");
      const issue = await getStore(ctx.cwd).create(params);
      return textResult(`Created ${summarize(issue)}\n${issueText(issue)}`, { issue });
    },
    renderCall: issueRenderer("create"),
    renderResult(result, _options, theme) {
      const issue = (result.details as { issue?: Issue } | undefined)?.issue;
      return new Text(issue ? theme.fg("success", `Created ${summarize(issue)}`) : "Created issue", 0, 0);
    },
  });

  pi.registerTool({
    name: "issue_search",
    label: "Search Issues",
    description: "Search issues by text and optional status, priority, type, assignee, or label. Returns at most 50 issues.",
    promptSnippet: "Search and filter persistent issues",
    promptGuidelines: ["Use issue_search before creating a possible duplicate and before reporting issue state."],
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      status: Type.Optional(StringEnum(ISSUE_STATUSES)),
      priority: Type.Optional(StringEnum(ISSUE_PRIORITIES)),
      type: Type.Optional(StringEnum(ISSUE_TYPES)),
      assignee: Type.Optional(Type.String()),
      label: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("issue search cancelled");
      const issues = await getStore(ctx.cwd).search(params);
      return textResult(
        issues.length ? issues.map(summarize).join("\n") : "No matching issues",
        { issues, count: issues.length },
      );
    },
    renderCall: issueRenderer("search"),
    renderResult(result, { expanded }, theme) {
      const issues = (result.details as { issues?: Issue[] } | undefined)?.issues ?? [];
      const shown = expanded ? issues : issues.slice(0, 5);
      let output = theme.fg("muted", `${issues.length} issue(s)`);
      for (const issue of shown) output += `\n${theme.fg("accent", issue.id)} ${issue.title}`;
      if (shown.length < issues.length) output += `\n${theme.fg("dim", `${issues.length - shown.length} more`)}`;
      return new Text(output, 0, 0);
    },
  });

  pi.registerTool({
    name: "issue_get",
    label: "Get Issue",
    description: "Read one issue including comments and audit history.",
    parameters: Type.Object({ id: Type.String({ description: "Issue ID, for example ISSUE-0001" }) }),
    async execute(_id, params, _signal, _update, ctx) {
      const issue = await getStore(ctx.cwd).get(params.id);
      if (!issue) throw new Error(`issue not found: ${params.id}`);
      return textResult(issueText(issue), { issue });
    },
    renderCall: issueRenderer("get"),
  });

  pi.registerTool({
    name: "issue_update",
    label: "Update Issue",
    description: "Update issue fields. Supply expected_updated_at for optimistic concurrency when acting on a previous read.",
    promptGuidelines: [
      "Use issue_update to record ownership, priority, and status changes; do not claim work is resolved without verification evidence.",
    ],
    parameters: Type.Object({
      id: Type.String(),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      status: Type.Optional(StringEnum(ISSUE_STATUSES)),
      priority: Type.Optional(StringEnum(ISSUE_PRIORITIES)),
      type: Type.Optional(StringEnum(ISSUE_TYPES)),
      assignee: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      labels: Type.Optional(Type.Array(Type.String())),
      actor: Type.Optional(Type.String()),
      expected_updated_at: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("issue update cancelled");
      const update = {
        ...(params.title !== undefined && { title: params.title }),
        ...(params.description !== undefined && { description: params.description }),
        ...(params.status !== undefined && { status: params.status as IssueStatus }),
        ...(params.priority !== undefined && { priority: params.priority as IssuePriority }),
        ...(params.type !== undefined && { type: params.type as IssueType }),
        ...(params.assignee !== undefined && { assignee: params.assignee }),
        ...(params.labels !== undefined && { labels: params.labels }),
        ...(params.actor !== undefined && { actor: params.actor }),
        ...(params.expected_updated_at !== undefined && { expectedUpdatedAt: params.expected_updated_at }),
      };
      const issue = await getStore(ctx.cwd).update(params.id, update);
      return textResult(`Updated ${summarize(issue)}\n${issueText(issue)}`, { issue });
    },
    renderCall: issueRenderer("update"),
    renderResult(result, _options, theme) {
      const issue = (result.details as { issue?: Issue } | undefined)?.issue;
      return new Text(theme.fg("success", issue ? `Updated ${summarize(issue)}` : "Updated issue"), 0, 0);
    },
  });

  pi.registerTool({
    name: "issue_comment",
    label: "Comment on Issue",
    description: "Append investigation evidence, a progress update, a decision, or resolution verification to an issue.",
    promptGuidelines: ["Use issue_comment to preserve material investigation evidence and verification results."],
    parameters: Type.Object({
      id: Type.String(),
      body: Type.String(),
      author: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("comment cancelled");
      const issue = await getStore(ctx.cwd).addComment(params.id, params.body, params.author);
      return textResult(`Commented on ${issue.id}`, { issue });
    },
    renderCall: issueRenderer("comment"),
  });

  pi.registerTool({
    name: "issue_metrics",
    label: "Issue Metrics",
    description: "Get cycle-time and queue statistics grouped by status, priority, type, assignee, and project, with optional filters.",
    parameters: Type.Object({
      assignee: Type.Optional(Type.String()),
      repository_url: Type.Optional(Type.String()),
      type: Type.Optional(StringEnum(ISSUE_TYPES)),
      created_from: Type.Optional(Type.String()),
      created_to: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const metrics = await getStore(ctx.cwd).metrics({
        ...(params.assignee !== undefined && { assignee: params.assignee }),
        ...(params.repository_url !== undefined && { repositoryUrl: params.repository_url }),
        ...(params.type !== undefined && { type: params.type }),
        ...(params.created_from !== undefined && { createdFrom: params.created_from }),
        ...(params.created_to !== undefined && { createdTo: params.created_to }),
      });
      return textResult(JSON.stringify(metrics, null, 2), { metrics });
    },
    renderCall: issueRenderer("metrics"),
  });

  pi.registerTool({
    name: "sls_query_evidence",
    label: "Query SLS Evidence",
    description: "Run a preconfigured, bounded read-only SLS query and attach its sanitized summary to an issue.",
    promptGuidelines: ["Use sls_query_evidence only with source and query template keys supplied by project configuration."],
    parameters: Type.Object({
      issue_id: Type.String(),
      source_key: Type.String(),
      query_name: Type.String(),
      parameters: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]))),
      from: Type.Integer({ description: "Unix timestamp at the start of the query window" }),
      to: Type.Integer({ description: "Unix timestamp at the end of the query window" }),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("SLS query cancelled");
      const connector = await getConnector();
      const evidence = await connector.querySls({
        sourceKey: params.source_key,
        queryName: params.query_name,
        ...(params.parameters !== undefined && { parameters: params.parameters }),
        from: params.from,
        to: params.to,
      });
      await getStore(ctx.cwd).addEvidence(params.issue_id, {
        source: "sls",
        summary: evidence.summary,
        locator: `${params.source_key}/${params.query_name}`,
      });
      return textResult(JSON.stringify(evidence, null, 2), { evidence });
    },
  });

  pi.registerTool({
    name: "dms_query_evidence",
    label: "Query DMS Evidence",
    description: "Run a preconfigured read-only SQL template through Alibaba Cloud DMS and attach its sanitized summary to an issue.",
    promptGuidelines: ["Use dms_query_evidence only with configured templates; never attempt DDL or DML for issue diagnosis."],
    parameters: Type.Object({
      issue_id: Type.String(),
      source_key: Type.String(),
      query_name: Type.String(),
      parameters: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]))),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("DMS query cancelled");
      const connector = await getConnector();
      const evidence = await connector.queryDms({
        sourceKey: params.source_key,
        queryName: params.query_name,
        ...(params.parameters !== undefined && { parameters: params.parameters }),
      });
      await getStore(ctx.cwd).addEvidence(params.issue_id, {
        source: "dms",
        summary: evidence.summary,
        locator: `${params.source_key}/${params.query_name}`,
      });
      return textResult(JSON.stringify(evidence, null, 2), { evidence });
    },
  });

  pi.registerTool({
    name: "mysql_query_evidence",
    label: "Query Test MySQL Evidence",
    description: "Run a preconfigured read-only query through Drizzle against the company test MySQL and attach sanitized evidence to an issue.",
    promptGuidelines: ["Use mysql_query_evidence only for company test environment evidence, never as production evidence."],
    parameters: Type.Object({
      issue_id: Type.String(),
      source_key: Type.String(),
      query_name: Type.String(),
      parameters: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]))),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("MySQL query cancelled");
      const connector = await getConnector();
      const evidence = await connector.queryMysql({
        sourceKey: params.source_key,
        queryName: params.query_name,
        ...(params.parameters !== undefined && { parameters: params.parameters }),
      });
      await getStore(ctx.cwd).addEvidence(params.issue_id, {
        source: "mysql",
        summary: evidence.summary,
        locator: `${params.source_key}/${params.query_name}`,
      });
      return textResult(JSON.stringify(evidence, null, 2), { evidence });
    },
  });

  pi.registerCommand("issues", {
    description: "Show recent issues; optional argument is a text query",
    handler: async (args, ctx) => {
      const query = args.trim();
      const issues = await getStore(ctx.cwd).search({ ...(query && { query }), limit: 20 });
      pi.appendEntry("issue-agent-list", {
        title: args.trim() ? `Issues matching: ${args.trim()}` : "Recent issues",
        lines: issues.map(summarize),
      });
    },
  });

  pi.registerCommand("issue", {
    description: "Show one issue by ID",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) {
        ctx.ui.notify("Usage: /issue ISSUE-0001", "warning");
        return;
      }
      const issue = await getStore(ctx.cwd).get(id);
      if (!issue) {
        ctx.ui.notify(`Issue not found: ${id}`, "error");
        return;
      }
      pi.appendEntry("issue-agent-list", { title: summarize(issue), lines: issueText(issue).split("\n") });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const metrics = await getStore(ctx.cwd).metrics();
    ctx.ui.setStatus("issue-agent", `${metrics.total} issues / ${metrics.unassigned} unassigned`);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const issueId = process.env.ISSUE_AGENT_ISSUE_ID;
    if (!notifier || !issueId || notifiedIssues.has(issueId)) return;
    const issue = await getStore(ctx.cwd).get(issueId);
    if (!issue || !["resolved", "closed"].includes(issue.status)) return;
    const backendPassed = issue.testRuns.some((run) => run.scope === "backend" && run.status === "passed");
    const frontendPassed = issue.testRuns.some((run) => run.scope === "frontend" && run.status === "passed");
    if (!backendPassed || !frontendPassed) return;
    try {
      await notifier.notifyCompleted(issue);
      notifiedIssues.add(issue.id);
      ctx.ui.notify(`DingTalk notified for ${issue.id}`, "info");
    } catch (error) {
      ctx.ui.notify(
        `DingTalk notification failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!event.toolName.startsWith("issue_") || event.isError) return;
    const metrics = await getStore(ctx.cwd).metrics();
    ctx.ui.setStatus("issue-agent", `${metrics.total} issues / ${metrics.unassigned} unassigned`);
  });
}
