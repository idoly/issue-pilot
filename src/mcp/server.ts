import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, ListResourceTemplatesRequestSchema, ListResourcesRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { lstat } from "node:fs/promises";
import { ISSUE_PRIORITIES, ISSUE_WORK_MODES } from "../domain/contracts.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { agentSessions } from "../db/schema.ts";
import { sessionTranscript } from "../agent/events.ts";
import { issueSessionRoot } from "../workspace/state.ts";
import { ensureCurrentSubject, requireIssue, type ApiRouteContext } from "../http/route-context.ts";

const limits = issuePilotConfig.limits.mcpServer;
const key = Type.String({ pattern: "^ISSUE-[0-9]{8}-[0-9]{3,}$", description: "工单编号" });
const paging = { offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: limits.pageItems })) };
const linePaging = { offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: limits.textLines })) };
const attachment = Type.Object({
  fileName: Type.String({ minLength: 1, maxLength: 255, description: "附件文件名，例如 report.xlsx；不能包含路径" }),
  mediaType: Type.Optional(Type.String({ maxLength: 200, description: "MIME 类型，默认 application/octet-stream" })),
  contentBase64: Type.String({ description: "标准 Base64 编码的完整文件内容，不含 data: 前缀" }),
}, { additionalProperties: false });
interface McpAttachment { fileName: string; mediaType?: string; contentBase64: string }
const mutations = new Set(["issue_create", "issue_message"]);
const definitions = [
  { name: "services_list", description: "列出可选服务和环境，创建工单前据此选择 serviceKey。", inputSchema: Type.Object({}, { additionalProperties: false }) },
  { name: "users_list", description: "查看当前连接身份和可分配的用户，subject 用作工单处理人或抄送人；不返回凭证。", inputSchema: Type.Object({}, { additionalProperties: false }) },
  { name: "issues_search", description: "按编号、标题、服务、环境或状态搜索工单。支持分页，offset 从 0 开始；创建请求结果不明时先搜索核对，避免重复创建。", inputSchema: Type.Object({ query: Type.Optional(Type.String({ maxLength: 200 })), service: Type.Optional(Type.String()), environment: Type.Optional(Type.String()), status: Type.Optional(Type.String()), ...paging }, { additionalProperties: false }) },
  { name: "issue_get", description: "读取工单详情、智能体是否正在运行、工作区状态、关联工单、附件和成果列表。创建或发送消息后调用本工具查看进展，再用 issue_conversation 读取回复。", inputSchema: Type.Object({ key }, { additionalProperties: false }) },
  { name: "issue_create", description: "创建工单，可通过 attachments 上传 Base64 附件，工单与附件一起保存后自动入队处理，立即返回工单编号。服务和用户由 services_list/users_list 发现。生产数据处理与开发需要开发角色；不要在超时后盲目重试，先搜索确认是否已创建。", inputSchema: Type.Object({ title: Type.String({ minLength: 1, maxLength: 300, description: "工单标题" }), serviceKey: Type.String({ minLength: 1, maxLength: 100, description: "服务 key" }), workMode: Type.Union(ISSUE_WORK_MODES.map(mode => Type.Literal(mode)), { description: "production_analysis 正式调查；test_analysis 测试调查；production_data 生产数据处理；development_fix 开发修复；development_feature 功能开发" }), description: Type.Optional(Type.String({ maxLength: 10000, description: "问题背景、需要完成的工作和验收要求" })), priority: Type.Optional(Type.Union(ISSUE_PRIORITIES.map(priority => Type.Literal(priority)), { description: "默认 p2" })), assigneeSubject: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()], { description: "处理人 subject，省略时未分配" })), ccSubjects: Type.Optional(Type.Array(Type.String({ maxLength: 255 }), { uniqueItems: true })), relatedIssueKeys: Type.Optional(Type.Array(key, { maxItems: issuePilotConfig.limits.relatedIssues, uniqueItems: true })), attachments: Type.Optional(Type.Array(attachment, { description: "创建时上传的附件；支持文本、图片和二进制文件" })) }, { additionalProperties: false }) },
  { name: "issue_message", description: "向指定工单的智能体发送补充信息、问题或继续处理要求。运行中进入引导/排队流程，空闲时继续处理，已解决工单拒绝。成功只表示已受理，随后读取 issue_get/issue_conversation 查看进展；响应不明时先核对对话，不自动重复发送。", inputSchema: Type.Object({ key, message: Type.String({ minLength: 1, maxLength: issuePilotConfig.limits.agentMessageChars, description: "发送给工单智能体的文本" }) }, { additionalProperties: false }) },
  { name: "issue_conversation", description: "分页读取工单对话和当前轮次进展，不包含内部提示词或凭证。offset 从 0 开始，nextOffset 指向后续内容；使用 issue_get 判断处理是否结束。", inputSchema: Type.Object({ key, ...paging }, { additionalProperties: false }) },
  { name: "attachment_read", description: "按工单和附件 ID 读取文本附件，先校验完整性。offset 从 0 开始；Excel 等二进制文件返回下载路径。附件 ID 从 issue_get 获取。", inputSchema: Type.Object({ key, attachmentId: Type.String(), ...linePaging }, { additionalProperties: false }) },
  { name: "output_read", description: "按工单和文件名读取交付成果的文本内容，Excel 等二进制文件返回下载路径。成果文件名从 issue_get 获取。", inputSchema: Type.Object({ key, fileName: Type.String({ minLength: 1, maxLength: 255 }), ...linePaging }, { additionalProperties: false }) },
];
const applicationTools = () => definitions.map(definition => ({ ...definition, annotations: { readOnlyHint: !mutations.has(definition.name), destructiveHint: false, ...mutations.has(definition.name) ? { idempotentHint: false } : {}, openWorldHint: mutations.has(definition.name) } }));
type Input = Record<string, unknown>;
const page = <T>(rows: T[], input: Input) => {
  const offset = typeof input.offset === "number" ? input.offset : 0;
  const limit = typeof input.limit === "number" ? input.limit : 30;
  const items = rows.slice(offset, offset + limit);
  return { total: rows.length, offset, items, nextOffset: offset + items.length < rows.length ? offset + items.length : null };
};
const isTextFile = (fileName: string) => /\.(csv|tsv|jsonl?|sql|txt|md|log|ya?ml|xml|properties|html|css|[cm]?[jt]sx?)$/i.test(fileName);
const lines = (text: string, input: Input) => page(text.split(/\r?\n/), { ...input, limit: input.limit ?? 200 });
const bounded = (value: unknown) => {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > limits.responseBytes) throw new Error("mcp_response_too_large_use_smaller_page");
  return { content: [{ type: "text" as const, text }] };
};

function createApplicationMcpServer(context: ApiRouteContext, request: Pick<FastifyRequest, "headers">) {
  const server = new Server({ name: "issue-pilot", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });
  const headers = typeof request.headers["x-issue-pilot-subject"] === "string" ? { "x-issue-pilot-subject": request.headers["x-issue-pilot-subject"] } : {};
  const api = async (url: string, payload?: Input, attachments: McpAttachment[] = []) => {
    let multipart: { payload: Buffer; headers: Record<string, string> } | undefined;
    if (attachments.length) {
      const form = new FormData();
      form.append("issue", JSON.stringify(payload));
      for (const file of attachments) {
        if (/[/\\\u0000-\u001f\u007f]/.test(file.fileName) || [".", ".."].includes(file.fileName) || Buffer.byteLength(file.fileName) > issuePilotConfig.limits.filesystemNameBytes) throw new Error("invalid_attachment_name");
        const mediaType = file.mediaType ?? "application/octet-stream";
        if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mediaType)) throw new Error("invalid_attachment_media_type");
        const content = Buffer.from(file.contentBase64, "base64");
        if (content.toString("base64") !== file.contentBase64) throw new Error("invalid_attachment_base64");
        form.append("files", new Blob([Uint8Array.from(content)], { type: mediaType }), file.fileName);
      }
      const encoded = new Request("http://localhost", { method: "POST", body: form });
      multipart = { payload: Buffer.from(await encoded.arrayBuffer()), headers: { ...headers, "content-type": encoded.headers.get("content-type")! } };
    }
    const response = await context.app.inject({ method: payload ? "POST" : "GET", url, headers, ...(multipart ?? (payload ? { payload } : {})) });
    if (response.statusCode >= 400) {
      let code = "mcp_api_failed";
      try { const error = JSON.parse(response.body).error; if (typeof error === "string" && /^[a-z_]+$/.test(error)) code = error; } catch {}
      throw new Error(code);
    }
    return response;
  };
  const issue = async (key: string) => JSON.parse((await api(`/api/issues/${encodeURIComponent(key)}`)).body);
  const fileText = (content: Buffer, fileName: string, downloadPath: string, input: Input) => {
    if (!isTextFile(fileName)) return { fileName, size: content.length, downloadPath, binary: true };
    return { fileName, downloadPath, ...lines(new TextDecoder("utf-8", { fatal: true }).decode(content), input) };
  };
  const call = async (name: string, input: Input): Promise<unknown> => {
    const key = String(input.key ?? "");
    if (name === "services_list") return JSON.parse((await api("/api/catalog")).body);
    if (name === "users_list") return { currentUser: JSON.parse((await api("/api/me")).body), users: JSON.parse((await api("/api/users")).body) };
    if (name === "issue_create") {
      const { attachments, ...fields } = input;
      return JSON.parse((await api("/api/issues", { description: "", priority: "p2", assigneeSubject: null, ccSubjects: [], relatedIssueKeys: [], ...fields }, attachments as McpAttachment[] | undefined)).body);
    }
    if (name === "issue_message") { await api(`/api/issues/${encodeURIComponent(key)}/agent-messages`, { message: input.message }); return { key, accepted: true, next: ["issue_get", "issue_conversation"] }; }
    if (name === "issues_search") {
      const rows = JSON.parse((await api("/api/issues")).body) as Array<Record<string, any>>;
      return page(rows.filter(row => (!input.query || `${row.id} ${row.title}`.toLowerCase().includes(String(input.query).toLowerCase())) && (!input.service || row.service.key === input.service) && (!input.environment || row.environmentKey === input.environment) && (!input.status || row.status === input.status)), input);
    }
    if (name === "issue_conversation") {
      const row = await requireIssue(context.database, key);
      const [binding] = await context.database.db.select().from(agentSessions).where(eq(agentSessions.issueId, row.id)).limit(1);
      let transcript = [] as ReturnType<typeof sessionTranscript>;
      if (binding) {
        if (path.dirname(path.resolve(binding.sessionFile)) !== issueSessionRoot(context.stateRoot, key)) throw new Error("mcp_session_path_invalid");
        if (!(await lstat(binding.sessionFile)).isFile()) throw new Error("mcp_session_path_invalid");
        transcript = sessionTranscript(SessionManager.open(binding.sessionFile), row.id);
      }
      const seen = new Set(transcript.map(event => event.id));
      return page([...transcript, ...context.events.replayCurrent(row.id).filter(event => !seen.has(event.id))], input);
    }
    const detail = await issue(key);
    if (name === "issue_get") { delete detail.workspace?.lastError; delete detail.workingDirectory; return detail; }
    if (name === "attachment_read") {
      const file = detail.attachments.find((file: { id: string }) => file.id === input.attachmentId);
      if (!file) throw new Error("attachment_not_found");
      const downloadPath = `/api/issues/${key}/attachments/${encodeURIComponent(file.id)}`;
      return fileText((await api(downloadPath)).rawPayload, file.fileName, downloadPath, input);
    }
    if (name === "output_read") {
      const file = detail.outputs.find((file: { fileName: string }) => file.fileName === input.fileName);
      if (!file) throw new Error("issue_output_not_found");
      const downloadPath = `/api/issues/${key}/outputs/${encodeURIComponent(file.fileName)}`;
      if (!isTextFile(file.fileName)) return { fileName: file.fileName, size: file.size, downloadPath, binary: true };
      return fileText((await api(downloadPath)).rawPayload, file.fileName, downloadPath, input);
    }
    throw new Error("mcp_tool_not_found");
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: applicationTools() }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const definition = definitions.find(row => row.name === request.params.name);
      if (!definition) throw new Error("mcp_tool_not_found");
      const input = Value.Parse(definition.inputSchema as TSchema, request.params.arguments ?? {}) as Input;
      return bounded(await call(definition.name, input));
    } catch (error) {
      const message = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "mcp_invalid_input_or_operation_failed";
      return { isError: true, content: [{ type: "text" as const, text: message }] };
    }
  });
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [{ uriTemplate: "issue-pilot://issues/{key}", name: "工单详情", mimeType: "application/json" }] }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: ["services", "users"].map(name => ({ uri: `issue-pilot://catalog/${name}`, name, mimeType: "application/json" })) }));
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    const catalog = /^issue-pilot:\/\/catalog\/(services|users)$/.exec(request.params.uri);
    const match = /^issue-pilot:\/\/issues\/(ISSUE-\d{8}-\d{3,})$/.exec(request.params.uri);
    if (!catalog && !match) throw new Error("mcp_resource_not_found");
    const result = bounded(await call(catalog ? `${catalog[1]}_list` : "issue_get", match ? { key: match[1] } : {}));
    return { contents: [{ uri: request.params.uri, mimeType: "application/json", text: result.content[0]!.text }] };
  });
  return server;
}

export function registerApplicationMcp(context: ApiRouteContext) {
  context.app.get("/api/endpoints", async (request, reply) => {
    await ensureCurrentSubject(context.database, request); reply.header("Cache-Control", "private, no-store");
    return { endpoints: [{ name: "Issue Pilot MCP", path: "/mcp", transport: "Streamable HTTP", readOnly: false, tools: applicationTools() }] };
  });
  context.app.post("/mcp", { logLevel: "silent", bodyLimit: limits.requestBytes }, async (request, reply) => {
    const subject = await ensureCurrentSubject(context.database, request);
    const server = createApplicationMcpServer(context, { headers: { "x-issue-pilot-subject": subject } });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    reply.raw.setHeader("Cache-Control", "private, no-store"); reply.hijack();
    reply.raw.once("close", () => { void transport.close().catch(() => {}); void server.close().catch(() => {}); });
    try { await server.connect(transport as Parameters<typeof server.connect>[0]); await transport.handleRequest(request.raw, reply.raw, request.body); }
    catch {
      if (!reply.raw.headersSent) reply.raw.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "mcp_request_failed" } }));
      else reply.raw.end();
    }
  });
  for (const method of ["GET", "DELETE"] as const) context.app.route({ method, url: "/mcp", logLevel: "silent", handler: (_request, reply) => reply.code(405).header("Allow", "POST").send({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Use stateless Streamable HTTP POST" } }) });
}
