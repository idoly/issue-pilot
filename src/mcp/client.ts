import { createHash } from "node:crypto";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { capabilityTextResult } from "../capabilities/contracts.ts";
import type { McpStdioConfiguration, McpTransport } from "../domain/contracts.ts";

export interface McpConfiguration { id: string; name: string; url: string; transport: McpTransport; authorization: string; enabled: boolean; stdio?: McpStdioConfiguration | null }
export interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }
export interface McpSession { readonly closed?: boolean; list(signal?: AbortSignal): Promise<McpTool[]>; call(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>; close(): Promise<void> }
export type McpConnector = (configuration: McpConfiguration, signal: AbortSignal, initializeSignal?: AbortSignal) => Promise<McpSession>;
const limits = issuePilotConfig.limits.capability.mcp;
const timedSignal = (signal?: AbortSignal) => AbortSignal.any([AbortSignal.timeout(limits.executionMs), ...(signal ? [signal] : [])]);
const readOnly = (tool: McpTool) => tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true;
class McpFailure extends Error {}

export const connectMcp: McpConnector = async (configuration, signal, initializeSignal = signal) => {
  let transport: SSEClientTransport | StreamableHTTPClientTransport | StdioClientTransport;
  if (configuration.transport === "stdio") {
    if (!configuration.stdio) throw new McpFailure("mcp_stdio_configuration_required");
    transport = new StdioClientTransport({ ...configuration.stdio, stderr: "pipe" });
    transport.stderr?.on("data", () => {});
  } else {
    const endpoint = new URL(configuration.url);
    const headers = configuration.authorization ? { Authorization: configuration.authorization } : {};
    const guardedFetch: typeof fetch = (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.protocol !== "https:" || target.origin !== endpoint.origin) throw new McpFailure("mcp_target_not_allowed");
      return fetch(input, { ...init, redirect: "error", signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
    };
    transport = configuration.transport === "sse"
      ? new SSEClientTransport(endpoint, { fetch: guardedFetch, requestInit: { headers } })
      : new StreamableHTTPClientTransport(endpoint, { fetch: guardedFetch, requestInit: { headers } });
  }
  const closeTransport = transport.close.bind(transport);
  let closing: Promise<void> | undefined;
  // Initialization cancellation and SDK failure cleanup can close concurrently.
  transport.close = () => closing ??= closeTransport();
  const startupSignal = AbortSignal.any([signal, initializeSignal]);
  const client = new Client({ name: "issue-pilot", version: "0.1.0" });
  let abortListener: (() => void) | undefined;
  try {
    startupSignal.throwIfAborted();
    // SDK HTTP sessionId uses string|undefined while Transport declares it optional.
    await Promise.race([client.connect(transport as Parameters<Client["connect"]>[0], { signal: startupSignal, timeout: limits.executionMs }), new Promise<never>((_, reject) => {
      abortListener = () => reject(startupSignal.reason); startupSignal.addEventListener("abort", abortListener, { once: true });
    })]);
  } catch {
    await transport.close().catch(() => {});
    throw new McpFailure(startupSignal.aborted ? "mcp_timeout_or_aborted" : "mcp_connection_failed");
  } finally { if (abortListener) startupSignal.removeEventListener("abort", abortListener); }
  return {
    get closed() { return !client.transport; },
    async list(operationSignal) {
      const active = operationSignal ? AbortSignal.any([signal, operationSignal]) : signal;
      const tools: McpTool[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
      do {
        const result = await client.listTools(cursor ? { cursor } : undefined, { signal: active, timeout: limits.executionMs });
        tools.push(...result.tools as McpTool[]);
        if (tools.length > limits.tools) throw new McpFailure("mcp_too_many_tools");
        cursor = result.nextCursor;
        if (cursor && (cursor.length > 1024 || cursors.has(cursor))) throw new McpFailure("mcp_invalid_cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new McpFailure("mcp_duplicate_tool_names");
      return tools;
    },
    call: (name, args, operationSignal) => client.callTool({ name, arguments: args }, undefined, { signal: operationSignal ? AbortSignal.any([signal, operationSignal]) : signal, timeout: limits.executionMs }),
    close: () => client.close(),
  };
};

/** An Agent session owns the connections; per-operation wrappers borrow them. */
export function createMcpConnectionPool(options: { cwd?: string; connect?: McpConnector } = {}) {
  const lifetime = new AbortController(), sessions = new Map<string, Promise<McpSession>>();
  let closing: Promise<void> | undefined;
  const connect: McpConnector = async (configuration, signal) => {
    if (lifetime.signal.aborted) throw new McpFailure("mcp_session_closed");
    signal.throwIfAborted();
    let pending = sessions.get(configuration.id);
    const existing = Boolean(pending);
    if (!pending) {
      const target = configuration.transport === "stdio" && configuration.stdio ? { ...configuration, stdio: { ...configuration.stdio, cwd: path.resolve(options.cwd ?? process.cwd(), configuration.stdio.cwd ?? ".") } } : configuration;
      pending = (options.connect ?? connectMcp)(target, lifetime.signal, signal);
      sessions.set(configuration.id, pending);
      const opened = pending;
      void pending.catch(() => { if (sessions.get(configuration.id) === opened) sessions.delete(configuration.id); });
    }
    const waiting = AbortSignal.any([lifetime.signal, signal]);
    let abortListener: (() => void) | undefined;
    let session: McpSession;
    try {
      session = await Promise.race([pending, new Promise<never>((_, reject) => {
        abortListener = () => reject(waiting.reason); waiting.addEventListener("abort", abortListener, { once: true });
      })]);
    } catch (error) {
      if (lifetime.signal.aborted) throw new McpFailure("mcp_session_closed");
      throw error;
    } finally { if (abortListener) waiting.removeEventListener("abort", abortListener); }
    waiting.throwIfAborted();
    if (existing && session.closed) {
      if (sessions.get(configuration.id) === pending) sessions.delete(configuration.id);
      return connect(configuration, signal);
    }
    const active = (operationSignal?: AbortSignal) => operationSignal ? AbortSignal.any([signal, operationSignal]) : signal;
    return { list: operationSignal => session.list(active(operationSignal)), call: (name, input, operationSignal) => session.call(name, input, active(operationSignal)), close: async () => {} };
  };
  return {
    connect,
    close: () => closing ??= (async () => {
      lifetime.abort();
      const opened = await Promise.allSettled(sessions.values()); sessions.clear();
      await Promise.all(opened.map(result => result.status === "fulfilled" ? result.value.close().catch(() => {}) : undefined));
    })(),
  };
}

async function withSession<T>(configuration: McpConfiguration, signal: AbortSignal | undefined, connect: McpConnector, operation: (session: McpSession) => Promise<T>): Promise<T> {
  const activeSignal = timedSignal(signal);
  let session: McpSession | undefined;
  try { session = await connect(configuration, activeSignal); return await operation(session); }
  catch (error) {
    if (activeSignal.aborted) throw new McpFailure(signal?.aborted ? "mcp_aborted" : "mcp_timeout");
    if (error instanceof McpFailure) throw error;
    throw new McpFailure(signal?.aborted ? "mcp_aborted" : "mcp_operation_failed");
  } finally { await session?.close().catch(() => {}); }
}

export async function inspectMcp(configuration: McpConfiguration, connect: McpConnector = connectMcp) {
  return withSession(configuration, undefined, connect, async (session) => (await session.list()).map((tool) => ({ name: tool.name, readOnly: readOnly(tool) })));
}

export interface McpToolBinding {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  call(input: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult<unknown>>;
}

export async function createMcpToolBindings(configurations: McpConfiguration[], writable: boolean, connect: McpConnector = connectMcp): Promise<McpToolBinding[]> {
  const tools: McpToolBinding[] = [];
  for (const stored of configurations.filter((configuration) => configuration.enabled)) {
    const configuration = structuredClone(stored);
    const discovered = await withSession(configuration, undefined, connect, (session) => session.list());
    for (const tool of discovered.filter((tool) => writable || readOnly(tool))) {
      if (tool.inputSchema.type !== "object") throw new McpFailure("mcp_invalid_tool_schema");
      const schema = Type.Unsafe<Record<string, unknown>>(tool.inputSchema);
      const suffix = createHash("sha256").update(`${configuration.id}\0${tool.name}`).digest("hex").slice(0, 20);
      tools.push({
        name: `mcp_${suffix}`, label: `${configuration.name} / ${tool.name}`,
        description: `${configuration.name}: ${tool.description ?? tool.name}`,
        parameters: schema,
        call: async (args, signal) => {
          return withSession(configuration, signal, connect, async (session) => {
            const current = (await session.list()).find((candidate) => candidate.name === tool.name);
            if (!current || !writable && !readOnly(current)) throw new McpFailure("mcp_tool_not_allowed");
            if (JSON.stringify(current.inputSchema) !== JSON.stringify(tool.inputSchema)) throw new McpFailure("mcp_tool_schema_changed");
            const result = await session.call(tool.name, args);
            const text = JSON.stringify(result);
            if (Buffer.byteLength(text) > issuePilotConfig.limits.capability.resultBytes) throw new McpFailure("mcp_result_too_large");
            if (result && typeof result === "object" && "isError" in result && result.isError) throw new McpFailure("mcp_tool_failed");
            return capabilityTextResult(text, { provider: "configured-mcp", service: configuration.name, tool: tool.name });
          });
        },
      });
    }
  }
  return tools;
}
