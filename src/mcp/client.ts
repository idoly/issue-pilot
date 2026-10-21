import { addAbortListener } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { McpStdioConfiguration, McpTransport } from "../domain/contracts.ts";

export interface McpConfiguration { id: string; name: string; url: string; transport: McpTransport; authorization: string; enabled: boolean; stdio?: McpStdioConfiguration | null }
export interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }
export interface McpSession { list(): Promise<McpTool[]>; close(): Promise<void> }
export type McpConnector = (configuration: McpConfiguration, signal: AbortSignal) => Promise<McpSession>;
const limits = issuePilotConfig.limits.capability.mcp;
class McpFailure extends Error {}

/** Keep requests on the configured HTTPS origin, including legacy SSE message endpoints. */
export function createMcpFetch(configuration: McpConfiguration, signal: AbortSignal): typeof fetch {
  const endpoint = new URL(configuration.url);
  return (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.protocol !== "https:" || target.origin !== endpoint.origin) throw new McpFailure("mcp_target_not_allowed");
    return fetch(input, { ...init, redirect: "error", signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
  };
}

/** All external MCP transports use the protocol SDK; Pi consumes them through its public adapter. */
export function createMcpTransport(configuration: McpConfiguration, signal: AbortSignal): Transport {
  if (configuration.transport === "stdio") {
    if (!configuration.stdio) throw new McpFailure("mcp_stdio_configuration_required");
    const transport = new StdioClientTransport({ ...configuration.stdio, stderr: "pipe" });
    transport.stderr?.on("data", () => {});
    return transport;
  }
  const endpoint = new URL(configuration.url);
  const headers = configuration.authorization ? { Authorization: configuration.authorization } : {};
  const guardedFetch = createMcpFetch(configuration, signal);
  return (configuration.transport === "sse"
    ? new SSEClientTransport(endpoint, { fetch: guardedFetch, requestInit: { headers } })
    : new StreamableHTTPClientTransport(endpoint, { fetch: guardedFetch, requestInit: { headers } })) as Transport;
}

/** The settings-page connection test uses the protocol client without starting an Agent. */
export const connectMcp: McpConnector = async (configuration, startupSignal) => {
  const transport = createMcpTransport(configuration, startupSignal);
  const closeTransport = transport.close.bind(transport);
  let closing: Promise<void> | undefined;
  transport.close = () => closing ??= closeTransport();
  const client = new Client({ name: "issue-pilot", version: "0.1.0" });
  let cancellation: ReturnType<typeof addAbortListener> | undefined;
  try {
    startupSignal.throwIfAborted();
    await Promise.race([client.connect(transport, { signal: startupSignal, timeout: limits.executionMs }), new Promise<never>((_, reject) => {
      cancellation = addAbortListener(startupSignal, () => reject(startupSignal.reason));
    })]);
  } catch {
    await transport.close().catch(() => {});
    throw new McpFailure(startupSignal.aborted ? "mcp_timeout_or_aborted" : "mcp_connection_failed");
  } finally { cancellation?.[Symbol.dispose](); }
  return {
    async list() {
      const tools: McpTool[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
      do {
        const result = await client.listTools(cursor ? { cursor } : undefined, { signal: startupSignal, timeout: limits.executionMs });
        tools.push(...result.tools as McpTool[]);
        if (tools.length > limits.tools) throw new McpFailure("mcp_too_many_tools");
        cursor = result.nextCursor;
        if (cursor && (cursor.length > 1024 || cursors.has(cursor))) throw new McpFailure("mcp_invalid_cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new McpFailure("mcp_duplicate_tool_names");
      return tools;
    },
    close: () => client.close(),
  };
};

export async function inspectMcp(configuration: McpConfiguration, connect: McpConnector = connectMcp) {
  const signal = AbortSignal.timeout(limits.executionMs);
  let session: McpSession | undefined;
  try {
    session = await connect(configuration, signal);
    return (await session.list()).map(tool => ({ name: tool.name, readOnly: tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true }));
  } catch (error) {
    if (signal.aborted) throw new McpFailure("mcp_timeout");
    if (error instanceof McpFailure) throw error;
    throw new McpFailure("mcp_operation_failed");
  } finally { await session?.close().catch(() => {}); }
}
