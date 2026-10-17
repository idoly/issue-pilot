import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { capabilityTextResult } from "../capabilities/contracts.ts";

export interface McpConfiguration { id: string; name: string; url: string; transport: "streamable_http" | "sse"; authorization: string; enabled: boolean }
export interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }
export interface McpSession { list(): Promise<McpTool[]>; call(name: string, input: Record<string, unknown>): Promise<unknown>; close(): Promise<void> }
export type McpConnector = (configuration: McpConfiguration, signal: AbortSignal) => Promise<McpSession>;
const limits = issuePilotConfig.limits.capability.mcp;
const timedSignal = (signal?: AbortSignal) => AbortSignal.any([AbortSignal.timeout(limits.executionMs), ...(signal ? [signal] : [])]);
const readOnly = (tool: McpTool) => tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true;

export const connectMcp: McpConnector = async (configuration, signal) => {
  const endpoint = new URL(configuration.url);
  const headers = configuration.authorization ? { Authorization: configuration.authorization } : {};
  const guardedFetch: typeof fetch = (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.protocol !== "https:" || target.origin !== endpoint.origin) throw new Error("mcp_target_not_allowed");
    return fetch(input, { ...init, redirect: "error", signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
  };
  const transport = configuration.transport === "sse"
    ? new SSEClientTransport(endpoint, { fetch: guardedFetch, requestInit: { headers } })
    : new StreamableHTTPClientTransport(endpoint, { fetch: guardedFetch, requestInit: { headers } });
  const client = new Client({ name: "issue-pilot", version: "0.1.0" });
  let abortListener: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    // SDK's HTTP transport exposes sessionId as string|undefined while Transport
    // declares it optional; the runtime contract is identical under exact optionals.
    await Promise.race([client.connect(transport as Parameters<Client["connect"]>[0]), new Promise<never>((_, reject) => {
      abortListener = () => reject(signal.reason); signal.addEventListener("abort", abortListener, { once: true });
    })]);
  } catch {
    await transport.close().catch(() => {});
    throw new Error(signal.aborted ? "mcp_timeout_or_aborted" : "mcp_connection_failed");
  } finally { if (abortListener) signal.removeEventListener("abort", abortListener); }
  return {
    async list() {
      const tools: McpTool[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
      do {
        const result = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout: limits.executionMs });
        tools.push(...result.tools as McpTool[]);
        if (tools.length > limits.tools) throw new Error("mcp_too_many_tools");
        cursor = result.nextCursor;
        if (cursor && (cursor.length > 1024 || cursors.has(cursor))) throw new Error("mcp_invalid_cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error("mcp_duplicate_tool_names");
      return tools;
    },
    call: (name, args) => client.callTool({ name, arguments: args }, undefined, { signal, timeout: limits.executionMs }),
    close: () => client.close(),
  };
};

async function withSession<T>(configuration: McpConfiguration, signal: AbortSignal | undefined, connect: McpConnector, operation: (session: McpSession) => Promise<T>): Promise<T> {
  const activeSignal = timedSignal(signal);
  const session = await connect(configuration, activeSignal);
  try { return await operation(session); }
  catch (error) {
    // Do not propagate remote errors that may echo tokens or sensitive input.
    if (activeSignal.aborted) throw new Error(signal?.aborted ? "mcp_aborted" : "mcp_timeout");
    if (error instanceof Error && /^mcp_[a-z_]+$/.test(error.message)) throw error;
    throw new Error(signal?.aborted ? "mcp_aborted" : "mcp_operation_failed");
  } finally { await session.close().catch(() => {}); }
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
      if (tool.inputSchema.type !== "object") throw new Error("mcp_invalid_tool_schema");
      const schema = Type.Unsafe<Record<string, unknown>>(tool.inputSchema);
      const suffix = createHash("sha256").update(`${configuration.id}\0${tool.name}`).digest("hex").slice(0, 20);
      tools.push({
        name: `mcp_${suffix}`, label: `${configuration.name} / ${tool.name}`,
        description: `${configuration.name}: ${tool.description ?? tool.name}`,
        parameters: schema,
        call: async (args, signal) => {
          return withSession(configuration, signal, connect, async (session) => {
            const current = (await session.list()).find((candidate) => candidate.name === tool.name);
            if (!current || !writable && !readOnly(current)) throw new Error("mcp_tool_not_allowed");
            if (JSON.stringify(current.inputSchema) !== JSON.stringify(tool.inputSchema)) throw new Error("mcp_tool_schema_changed");
            const result = await session.call(tool.name, args);
            const text = JSON.stringify(result);
            if (Buffer.byteLength(text) > issuePilotConfig.limits.capability.resultBytes) throw new Error("mcp_result_too_large");
            if (result && typeof result === "object" && "isError" in result && result.isError) throw new Error("mcp_tool_failed");
            return capabilityTextResult(text, { provider: "configured-mcp", service: configuration.name, tool: tool.name });
          });
        },
      });
    }
  }
  return tools;
}
