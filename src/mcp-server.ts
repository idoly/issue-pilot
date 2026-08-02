#!/usr/bin/env -S node --experimental-strip-types

import { resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { AliyunEvidenceConnector } from "./aliyun-connectors.ts";
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  ISSUE_TYPES,
  IssueStore,
  type CreateIssueInput,
  type SearchIssueInput,
  type UpdateIssueInput,
} from "./store.ts";

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export function createIssueMcpServer(store: IssueStore, connector?: AliyunEvidenceConnector): McpServer {
  const server = new McpServer({ name: "issue-agent", version: "0.1.0" });

  server.registerTool("issue_create", {
    title: "Create issue",
    description: "Create an engineering or support issue after checking for duplicates.",
    inputSchema: {
      title: z.string().min(1).max(300),
      description: z.string().optional(),
      priority: z.enum(ISSUE_PRIORITIES).optional(),
      type: z.enum(ISSUE_TYPES).optional(),
      assignee: z.string().optional(),
      reporter: z.string().optional(),
      labels: z.array(z.string()).optional(),
      repositories: z.array(z.object({ url: z.string().min(1), baseBranch: z.string().min(1) })).optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  }, async (input) => result(await store.create(compact(input) as CreateIssueInput)));

  server.registerTool("issue_search", {
    title: "Search issues",
    description: "Search and filter issues. Use before creating a possible duplicate.",
    inputSchema: {
      query: z.string().optional(),
      status: z.enum(ISSUE_STATUSES).optional(),
      priority: z.enum(ISSUE_PRIORITIES).optional(),
      type: z.enum(ISSUE_TYPES).optional(),
      assignee: z.string().optional(),
      label: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async (input) => result(await store.search(compact(input) as SearchIssueInput)));

  server.registerTool("issue_get", {
    title: "Get issue",
    description: "Read one issue with repositories, evidence, diagnosis, tests, comments, and session metadata.",
    inputSchema: { id: z.string().min(1) },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ id }) => {
    const issue = await store.get(id);
    if (!issue) throw new Error(`issue not found: ${id}`);
    return result(issue);
  });

  server.registerTool("issue_update", {
    title: "Update issue",
    description: "Update issue lifecycle fields with optional optimistic concurrency control.",
    inputSchema: {
      id: z.string().min(1),
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      status: z.enum(ISSUE_STATUSES).optional(),
      priority: z.enum(ISSUE_PRIORITIES).optional(),
      type: z.enum(ISSUE_TYPES).optional(),
      assignee: z.string().nullable().optional(),
      labels: z.array(z.string()).optional(),
      actor: z.string().optional(),
      expectedUpdatedAt: z.string().optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  }, async ({ id, ...input }) => result(await store.update(id, compact(input) as UpdateIssueInput)));

  server.registerTool("issue_comment", {
    title: "Comment on issue",
    description: "Append investigation evidence, progress, a decision, or verification to an issue.",
    inputSchema: { id: z.string().min(1), body: z.string().min(1), author: z.string().optional() },
    annotations: { destructiveHint: false, idempotentHint: false },
  }, async ({ id, body, author }) => result(await store.addComment(id, body, author)));

  server.registerTool("issue_record_evidence", {
    title: "Record issue evidence",
    description: "Record a sanitized evidence summary from SLS, DMS, code, an attachment, a user, or a test. Do not include credentials or secrets.",
    inputSchema: {
      id: z.string().min(1),
      source: z.enum(["sls", "dms", "mysql", "code", "attachment", "user", "test"]),
      summary: z.string().min(1),
      locator: z.string().nullable().optional(),
      createdBy: z.string().optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  }, async ({ id, ...input }) => result(await store.addEvidence(
    id,
    compact(input) as Parameters<IssueStore["addEvidence"]>[1],
  )));

  server.registerTool("issue_record_diagnosis", {
    title: "Record issue diagnosis",
    description: "Classify whether the issue is a bug and record root cause, confidence, and supporting evidence IDs.",
    inputSchema: {
      id: z.string().min(1),
      classification: z.enum(["pending", "bug", "not_bug", "change_request", "cannot_determine"]),
      rootCause: z.string().nullable().optional(),
      confidence: z.number().min(0).max(1).nullable().optional(),
      evidenceIds: z.array(z.string()).optional(),
      updatedBy: z.string().optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  }, async ({ id, ...input }) => result(await store.recordDiagnosis(
    id,
    compact(input) as Parameters<IssueStore["recordDiagnosis"]>[1],
  )));

  server.registerTool("issue_record_test", {
    title: "Record issue test run",
    description: "Record a backend, frontend, or integration test result used to verify a fix.",
    inputSchema: {
      id: z.string().min(1),
      scope: z.enum(["backend", "frontend", "integration"]),
      command: z.string().min(1),
      status: z.enum(["passed", "failed", "blocked"]),
      summary: z.string().min(1),
      createdBy: z.string().optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  }, async ({ id, ...input }) => result(await store.recordTestRun(
    id,
    compact(input) as Parameters<IssueStore["recordTestRun"]>[1],
  )));

  server.registerTool("issue_metrics", {
    title: "Issue metrics",
    description: "Get cycle-time and queue statistics by status, priority, type, assignee, and project.",
    inputSchema: {
      assignee: z.string().optional(),
      repositoryUrl: z.string().optional(),
      type: z.enum(ISSUE_TYPES).optional(),
      createdFrom: z.string().optional(),
      createdTo: z.string().optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async (input) => result(await store.metrics(compact(input) as Parameters<IssueStore["metrics"]>[0])));

  if (connector) {
    server.registerTool("sls_query_evidence", {
      title: "Query SLS evidence",
      description: "Run a preconfigured bounded SLS query and record sanitized evidence on an issue.",
      inputSchema: {
        issueId: z.string().min(1), sourceKey: z.string().min(1), queryName: z.string().min(1),
        parameters: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
        from: z.number().int(), to: z.number().int(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, async ({ issueId, ...input }) => {
      const evidence = await connector.querySls(compact(input) as Parameters<AliyunEvidenceConnector["querySls"]>[0]);
      await store.addEvidence(issueId, { source: "sls", summary: evidence.summary, locator: `${input.sourceKey}/${input.queryName}` });
      return result(evidence);
    });

    server.registerTool("dms_query_evidence", {
      title: "Query DMS evidence",
      description: "Run a preconfigured read-only DMS SQL template and record sanitized evidence on an issue.",
      inputSchema: {
        issueId: z.string().min(1), sourceKey: z.string().min(1), queryName: z.string().min(1),
        parameters: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, async ({ issueId, ...input }) => {
      const evidence = await connector.queryDms(compact(input) as Parameters<AliyunEvidenceConnector["queryDms"]>[0]);
      await store.addEvidence(issueId, { source: "dms", summary: evidence.summary, locator: `${input.sourceKey}/${input.queryName}` });
      return result(evidence);
    });

    server.registerTool("mysql_query_evidence", {
      title: "Query test MySQL evidence",
      description: "Run a preconfigured read-only query through Drizzle against company test MySQL and record sanitized evidence.",
      inputSchema: {
        issueId: z.string().min(1), sourceKey: z.string().min(1), queryName: z.string().min(1),
        parameters: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, async ({ issueId, ...input }) => {
      const evidence = await connector.queryMysql(compact(input) as Parameters<AliyunEvidenceConnector["queryMysql"]>[0]);
      await store.addEvidence(issueId, { source: "mysql", summary: evidence.summary, locator: `${input.sourceKey}/${input.queryName}` });
      return result(evidence);
    });
  }

  return server;
}

async function main(): Promise<void> {
  const filePath = resolve(process.cwd(), process.env.ISSUE_AGENT_DATA_FILE ?? ".issue-agent/issues.json");
  const connector = process.env.ISSUE_AGENT_CONNECTORS_FILE
    ? await AliyunEvidenceConnector.fromFile(process.env.ISSUE_AGENT_CONNECTORS_FILE)
    : undefined;
  const server = createIssueMcpServer(new IssueStore(filePath), connector);
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
