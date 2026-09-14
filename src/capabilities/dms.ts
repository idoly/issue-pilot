import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { capabilityTextResult } from "./contracts.ts";
import type { CapabilityConfig, CapabilityInputs } from "./registry.ts";
import { validateReadOnlySql } from "./sql.ts";

const limits = issuePilotConfig.limits.capability.dms;

export type DmsMcpTool = {
  name: string;
  description?: string;
  inputSchema: { type: "object" } & Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};

export interface DmsMcpSession {
  listTools(signal: AbortSignal): Promise<DmsMcpTool[]>;
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export type ConnectDmsMcp = (configured: CapabilityConfig<"dms">, signal: AbortSignal) => Promise<DmsMcpSession>;

function operationSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(limits.executionMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const rejectAborted = () => reject(signal.reason instanceof Error ? signal.reason : new Error("dms_mcp_aborted"));
    if (signal.aborted) rejectAborted();
    else signal.addEventListener("abort", rejectAborted, { once: true });
  });
}

function sameOriginFetch(origin: string, signal: AbortSignal) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = new URL(input instanceof Request ? input.url : input.toString());
    if (target.protocol !== "https:" || target.origin !== origin) throw new Error("invalid_dms_mcp_target");
    const requestSignal = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
    return fetch(input, { ...init, redirect: "error", signal: requestSignal });
  };
}

export const connectDmsMcp: ConnectDmsMcp = async (configured, signal) => {
  const target = new URL(configured.url);
  if (target.protocol !== "https:" || target.username || target.password || target.search || target.hash) throw new Error("invalid_dms_mcp_target");
  const headers = { Authorization: configured.authorization };
  const restrictedFetch = sameOriginFetch(target.origin, signal);
  const transport = new SSEClientTransport(target, {
    fetch: restrictedFetch,
    requestInit: { headers },
  });
  const client = new Client({ name: "issue-pilot", version: "0.1.0" });
  try {
    await Promise.race([client.connect(transport), abortPromise(signal)]);
  } catch {
    await transport.close().catch(() => undefined);
    throw new Error("dms_mcp_connection_failed");
  }
  return {
    async listTools(requestSignal) {
      const tools: DmsMcpTool[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = await client.listTools(cursor ? { cursor } : undefined, { signal: requestSignal, timeout: limits.executionMs, maxTotalTimeout: limits.executionMs });
        tools.push(...result.tools as DmsMcpTool[]);
        cursor = result.nextCursor;
        if (cursor && (cursor.length > 1024 || cursors.has(cursor))) throw new Error("dms_mcp_invalid_cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return tools;
    },
    async callTool(name, args, requestSignal) {
      return client.callTool({ name, arguments: args }, undefined, { signal: requestSignal, timeout: limits.executionMs, maxTotalTimeout: limits.executionMs });
    },
    close: () => client.close(),
  };
};

function isReadOnlyScriptTool(tool: DmsMcpTool): boolean {
  if (tool.name !== "executeScript") return false;
  const properties = tool.inputSchema.properties;
  const required = tool.inputSchema.required;
  if (!properties || typeof properties !== "object" || Array.isArray(properties) || !Array.isArray(required)) return false;
  const fields = properties as Record<string, unknown>;
  const databaseId = fields.database_id;
  const script = fields.script;
  return required.includes("database_id") && required.includes("script")
    && databaseId !== null && typeof databaseId === "object" && !Array.isArray(databaseId) && (databaseId as Record<string, unknown>).type === "string"
    && script !== null && typeof script === "object" && !Array.isArray(script) && (script as Record<string, unknown>).type === "string";
}

function uniqueTool(tools: DmsMcpTool[], name: string, accepts: (tool: DmsMcpTool) => boolean): DmsMcpTool | undefined {
  const matches = tools.filter((tool) => tool.name === name && accepts(tool));
  return matches.length === 1 ? matches[0] : undefined;
}

function isReadOnlyTool(tool: DmsMcpTool): boolean {
  return tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true;
}

function executeScriptArguments(input: CapabilityInputs["dms"], databaseId: string): Record<string, unknown> {
  return {
    database_id: databaseId,
    script: validateReadOnlySql(input.script, Number.MAX_SAFE_INTEGER),
    ...(input.logic === undefined ? {} : { logic: input.logic }),
  };
}

function mcpTextRecords(result: unknown, failureCode: string, invalidCode: string): Array<Record<string, unknown>> {
  if (!result || typeof result !== "object" || ("isError" in result && result.isError === true) || !("content" in result) || !Array.isArray(result.content)) throw new Error(failureCode);
  return result.content.flatMap((item) => {
    if (!item || typeof item !== "object" || !("type" in item) || item.type !== "text" || !("text" in item) || typeof item.text !== "string") return [];
    let value: unknown;
    try { value = JSON.parse(item.text); } catch { throw new Error(invalidCode); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(invalidCode);
    return [value as Record<string, unknown>];
  });
}

export interface DmsScopeResolution {
  instanceId: string;
  instanceHost: string;
  instancePort: string;
  instanceLabel: string;
  databaseId: string;
  databaseLabel: string;
}

export async function resolveDmsScope(configured: CapabilityConfig<"dms">, instanceAlias: string, schemaName: string, signal?: AbortSignal): Promise<DmsScopeResolution> {
  const boundedSignal = operationSignal(signal);
  const session = await connectDmsMcp(configured, boundedSignal);
  try {
    const tools = await session.listTools(boundedSignal);
    const instanceTool = uniqueTool(tools, "listInstances", isReadOnlyTool);
    const databaseTool = uniqueTool(tools, "getDatabase", isReadOnlyTool);
    if (!instanceTool || !databaseTool) throw new Error("dms_mcp_scope_resolve_unavailable");
    const normalizedAlias = instanceAlias.trim();
    const instanceResult = await session.callTool(instanceTool.name, { search_key: normalizedAlias, db_type: null, env_type: null }, boundedSignal);
    const matchingInstances = mcpTextRecords(instanceResult, "dms_mcp_scope_resolve_failed", "dms_mcp_scope_resolve_invalid_response").filter((instance) => instance.InstanceAlias === normalizedAlias);
    if (matchingInstances.length !== 1) throw new Error("dms_mcp_scope_resolve_invalid_response");
    const instance = matchingInstances[0]!;
    const instanceId = typeof instance.InstanceId === "number" && Number.isSafeInteger(instance.InstanceId) ? String(instance.InstanceId) : typeof instance.InstanceId === "string" ? instance.InstanceId.trim() : "";
    const instanceHost = typeof instance.Host === "string" ? instance.Host.trim() : "";
    const instancePort = typeof instance.Port === "number" && Number.isSafeInteger(instance.Port) ? String(instance.Port) : typeof instance.Port === "string" ? instance.Port.trim() : "";
    const instanceType = typeof instance.InstanceType === "string" ? instance.InstanceType.trim() : "";
    const environment = typeof instance.EnvType === "string" ? instance.EnvType.trim() : "";
    if (!instanceId || !instanceHost || !instancePort || !instanceType || !environment) throw new Error("dms_mcp_scope_resolve_invalid_response");
    const normalizedSchema = schemaName.trim();
    const databaseResult = await session.callTool(databaseTool.name, { host: instanceHost, port: instancePort, schema_name: normalizedSchema, sid: null }, boundedSignal);
    const databases = mcpTextRecords(databaseResult, "dms_mcp_scope_resolve_failed", "dms_mcp_scope_resolve_invalid_response");
    if (databases.length !== 1) throw new Error("dms_mcp_scope_resolve_invalid_response");
    const database = databases[0]!;
    const databaseId = typeof database.DatabaseId === "number" && Number.isSafeInteger(database.DatabaseId) ? String(database.DatabaseId) : typeof database.DatabaseId === "string" ? database.DatabaseId.trim() : "";
    const resolvedInstanceId = typeof database.InstanceId === "number" && Number.isSafeInteger(database.InstanceId) ? String(database.InstanceId) : typeof database.InstanceId === "string" ? database.InstanceId.trim() : "";
    const resolvedSchema = typeof database.SchemaName === "string" ? database.SchemaName.trim() : "";
    if (!databaseId || resolvedInstanceId !== instanceId || resolvedSchema !== normalizedSchema) throw new Error("dms_mcp_scope_resolve_invalid_response");
    return {
      instanceId,
      instanceHost,
      instancePort,
      instanceLabel: `${normalizedAlias} · ${instanceHost}:${instancePort} · ${instanceType}/${environment}`,
      databaseId,
      databaseLabel: resolvedSchema,
    };
  } finally {
    await session.close();
  }
}

export async function queryDms(
  input: CapabilityInputs["dms"],
  configured: CapabilityConfig<"dms">,
  signal?: AbortSignal,
  connect: ConnectDmsMcp = connectDmsMcp,
) {
  if (!configured.databaseId) throw new Error("dms_database_not_configured");
  const boundedSignal = operationSignal(signal);
  const session = await connect(configured, boundedSignal);
  try {
    const tool = uniqueTool(await session.listTools(boundedSignal), "executeScript", isReadOnlyScriptTool);
    if (!tool) throw new Error("dms_mcp_execute_script_unavailable");
    const result = await session.callTool(tool.name, executeScriptArguments(input, configured.databaseId), boundedSignal);
    if (result && typeof result === "object" && "isError" in result && result.isError === true) throw new Error("dms_mcp_tool_failed");
    return capabilityTextResult(JSON.stringify({ tool: tool.name, result }, null, 2), { provider: "aliyun-dms-mcp", tool: tool.name });
  } finally {
    await session.close();
  }
}
