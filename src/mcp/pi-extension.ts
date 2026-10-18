import { addAbortListener, EventEmitter } from "node:events";
import { devNull } from "node:os";
import path from "node:path";
import { createMcpExtension, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { McpHttpError, McpSessionExpiredError, StdioTransport, StreamableHttpTransport, type JsonRpcMessage, type McpTransport } from "@earendil-works/pi-mcp";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { AgentCodemodeMode } from "../domain/contracts.ts";
import { createMcpFetch, createMcpTransport, type McpConfiguration, type McpTool } from "./client.ts";

const limits = issuePilotConfig.limits.capability;
type Validators = Map<string, ReturnType<typeof Compile>>;

/** Pi owns discovery, tool registration, reconnects and shutdown; DB configuration stays authoritative. */
export function createIssueMcpExtension(configurations: McpConfiguration[], codemode: AgentCodemodeMode): ExtensionFactory {
  const configured = structuredClone(configurations.filter(configuration => configuration.enabled));
  const exposure = codemode === "off" ? "direct" : "codemode";
  const extension = createMcpExtension({
    loadConfig: () => ({
      errors: [], autoEnableCodemode: false,
      servers: configured.map(configuration => ({
        name: configuration.id, source: "Issue Pilot", scope: "extension" as const,
        config: {
          ...(configuration.transport === "stdio" ? configuration.stdio! : { url: configuration.url, headers: { Authorization: configuration.authorization } }),
          exposure, timeout: limits.mcp.executionMs / 1000, description: configuration.name,
        },
      })),
    }),
    logPath: devNull,
    createTransport: (entry, cwd) => {
      const stored = configured.find(configuration => configuration.id === entry.name);
      if (!stored) throw new Error("mcp_service_not_configured");
      const configuration = stored.stdio ? { ...stored, stdio: { ...stored.stdio, cwd: path.resolve(cwd, stored.stdio.cwd ?? ".") } } : stored;
      const lifetime = new AbortController();
      const legacy = configuration.transport === "sse" ? createMcpTransport(configuration, lifetime.signal) : undefined;
      const native: McpTransport | undefined = legacy ? undefined : configuration.transport === "stdio"
        ? new StdioTransport({ ...configuration.stdio!, env: { ...getDefaultEnvironment(), ...configuration.stdio!.env }, inheritEnv: false, stderr: "pipe" })
        : new StreamableHttpTransport({ url: configuration.url, headers: configuration.authorization ? { Authorization: configuration.authorization } : {}, fetch: createMcpFetch(configuration, lifetime.signal) });
      const transport = legacy ?? native!;
      const events = new EventEmitter();
      let validators: Validators = new Map();
      const requests = new Map<string | number, Validators>();
      const pages = new Map<string, Validators>();
      let closing: Promise<void> | undefined;
      const close = () => closing ??= (async () => { lifetime.abort(); await transport.close(); })();
      const onMessage = (message: JsonRpcMessage) => {
        if ("method" in message || !("id" in message) || message.id === undefined) { events.emit("message", message); return; }
        const previous = requests.get(message.id); requests.delete(message.id);
        try {
          if ("error" in message) {
            events.emit("message", { ...message, error: { code: message.error.code, message: "mcp_operation_failed" } });
            return;
          }
          if ("result" in message) {
            if (Buffer.byteLength(JSON.stringify(message.result)) > limits.resultBytes) throw new Error("mcp_result_too_large");
            if (previous) {
              const result = message.result as { tools: McpTool[]; nextCursor?: string };
              for (const tool of result.tools) {
                if (previous.has(tool.name)) throw new Error("mcp_duplicate_tool_names");
                if (tool.inputSchema.type && tool.inputSchema.type !== "object") throw new Error("mcp_invalid_tool_schema");
                previous.set(tool.name, Compile(Type.Unsafe({ ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} })));
              }
              if (previous.size > limits.mcp.tools) throw new Error("mcp_too_many_tools");
              if (result.nextCursor) {
                if (result.nextCursor.length > 1024) throw new Error("mcp_invalid_cursor");
                pages.set(result.nextCursor, previous);
              } else { validators = previous; pages.clear(); }
            }
            if ((message.result as { isError?: boolean }).isError === true) {
              events.emit("message", { jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: "mcp_tool_failed" }] } });
              return;
            }
          }
          events.emit("message", message);
        } catch (error) {
          const reason = error instanceof Error && /^mcp_[a-z_]+$/.test(error.message) ? error.message : "mcp_operation_failed";
          events.emit("message", { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: reason } });
        }
      };
      const onError = () => { events.emit("failure", new Error("mcp_connection_failed")); };
      const onClose = () => { events.emit("close"); };
      if (legacy) {
        legacy.onmessage = message => { onMessage(message as JsonRpcMessage); };
        legacy.onerror = onError; legacy.onclose = onClose;
      } else { native!.onMessage(onMessage); native!.onError(onError); native!.onClose(onClose); }
      return {
        async start() {
          const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(limits.mcp.executionMs)]);
          let cancellation: ReturnType<typeof addAbortListener> | undefined;
          try {
            signal.throwIfAborted();
            await Promise.race([transport.start(), new Promise<never>((_, reject) => {
              cancellation = addAbortListener(signal, () => reject(new Error("mcp_timeout_or_aborted")));
            })]);
          } catch {
            await close();
            throw new Error(signal.aborted ? "mcp_timeout_or_aborted" : "mcp_connection_failed");
          } finally { cancellation?.[Symbol.dispose](); }
        },
        async send(message, options) {
          options?.signal?.throwIfAborted();
          if ("method" in message) {
            const input = message.params as { name?: string; arguments?: unknown; cursor?: string } | undefined;
            if (message.method === "tools/list" && "id" in message) requests.set(message.id, new Map(input?.cursor ? pages.get(input.cursor) : undefined));
            if (message.method === "tools/call" && !validators.get(input?.name ?? "")?.Check(input?.arguments ?? {})) throw new Error("invalid_mcp_tool_input");
          }
          try {
            if (legacy) await legacy.send(message as JSONRPCMessage);
            else await native!.send(message, options);
          } catch (error) {
            if (error instanceof McpSessionExpiredError) throw new McpSessionExpiredError();
            if (error instanceof McpHttpError) throw new McpHttpError(error.status, "mcp_operation_failed");
            throw new Error("mcp_operation_failed");
          }
        },
        close,
        onMessage(listener) { events.on("message", listener); return () => { events.off("message", listener); }; },
        onError(listener) { events.on("failure", listener); return () => { events.off("failure", listener); }; },
        onClose(listener) { events.on("close", listener); return () => { events.off("close", listener); }; },
        setProtocolVersion(version) { transport.setProtocolVersion?.(version); },
      };
    },
  });
  // Configuration is managed by HTTP/DB, so the terminal manager must not create a second owner.
  return pi => extension({ ...pi, registerCommand() {} });
}
