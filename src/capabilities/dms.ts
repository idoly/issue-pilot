import { setTimeout as delay } from "node:timers/promises";
import { addAbortListener } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { capabilityTextResult } from "./contracts.ts";
import type { CapabilityConfig, CapabilityInputs } from "./registry.ts";
import { outputFileName, type IssueOutputStore } from "../outputs/store.ts";
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

type DmsConnectionConfiguration = Pick<CapabilityConfig<"dms">, "url" | "authorization">;

export type ConnectDmsMcp = (configured: DmsConnectionConfiguration, signal: AbortSignal) => Promise<DmsMcpSession>;

function operationSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(limits.executionMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function cancellationError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason.name === "TimeoutError" ? new Error("dms_mcp_timeout") : signal.reason;
  return new Error("dms_mcp_aborted");
}

async function withDmsSession<T>(session: Pick<DmsMcpSession, "close">, signal: AbortSignal, operation: (close: () => Promise<void>) => Promise<T>): Promise<T> {
  let closing: Promise<void> | undefined;
  const close = () => closing ??= Promise.resolve().then(() => session.close());
  let failure: { error: unknown } | undefined;
  try { return await operation(close); }
  catch (error) { failure = { error }; throw error; }
  finally {
    try { await close(); }
    catch (cleanupError) {
      signal.throwIfAborted();
      // An export may have already awaited this same close failure before publication.
      if (!failure || failure.error === cleanupError) throw cleanupError;
      const primary = failure.error;
      throw new AggregateError([primary, cleanupError], primary instanceof Error ? primary.message : "dms_mcp_operation_cleanup_failed");
    }
  }
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  if (/^\d+$/.test(value.trim())) {
    const milliseconds = Number(value) * 1_000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  const date = /[a-z]/i.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

type DmsHttpFailure = { status: number; retryAfterMs: number | undefined };

class DmsHttpError extends Error {
  readonly retryAfterSeconds: number | undefined;
  constructor(failure: DmsHttpFailure) {
    super(`dms_mcp_http_${failure.status}`);
    this.retryAfterSeconds = failure.retryAfterMs === undefined ? undefined : Math.ceil(failure.retryAfterMs / 1_000);
  }
}

type DmsPhase = "connect" | "discovery" | "execute" | "publish" | "close";
export interface DmsDiagnostics {
  phase: DmsPhase;
  elapsedMs: number;
  phaseElapsedMs: Partial<Record<DmsPhase, number>>;
  sqlDispatchAttempted: boolean;
  retryAfterSeconds?: number;
}

export class DmsOperationError extends Error {
  readonly diagnostics: DmsDiagnostics;
  constructor(diagnostics: DmsDiagnostics, cause: unknown) {
    // Keep only owner-defined codes; SDK messages may contain private targets or payloads.
    const code = cause instanceof Error ? cause.message : "";
    const safeCode = /^dms_mcp_(?:http_[45]\d\d|timeout|aborted|connection_failed|scope_resolve_(?:failed|unavailable|invalid_response)|invalid_cursor|execute_script_unavailable|tool_failed|operation_cleanup_failed)$/.test(code)
      || ["invalid_dms_mcp_target", "invalid_output_file_name", "insecure_issue_output_root", "insecure_issue_output_file"].includes(code);
    super(safeCode ? code : "dms_mcp_operation_failed", { cause });
    this.diagnostics = diagnostics;
  }
}

function sameOriginFetch(origin: string, signal: AbortSignal, onHttpFailure: (failure: DmsHttpFailure) => void) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = new URL(input instanceof Request ? input.url : input.toString());
    if (target.protocol !== "https:" || target.origin !== origin) throw new Error("invalid_dms_mcp_target");
    const requestSignal = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
    const response = await fetch(input, { ...init, redirect: "error", signal: requestSignal });
    if (response.status >= 400 && response.status <= 599) {
      const failure = { status: response.status, retryAfterMs: response.status === 429 ? retryAfterMs(response.headers.get("retry-after")) : undefined };
      onHttpFailure(failure);
      void response.body?.cancel().catch(() => undefined);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method !== "GET") throw new DmsHttpError(failure);
    }
    return response;
  };
}

export async function connectDmsMcp(configured: DmsConnectionConfiguration, signal: AbortSignal, firstHandshakeMs: number = limits.firstHandshakeMs): Promise<DmsMcpSession> {
  const target = new URL(configured.url);
  if (target.protocol !== "https:" || target.username || target.password || target.search || target.hash) throw new Error("invalid_dms_mcp_target");
  const headers = { Authorization: configured.authorization };
  let client: Client | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const handshakeController = new AbortController();
    const handshakeTimer = attempt === 0 ? setTimeout(() => handshakeController.abort(new DOMException("DMS handshake timed out", "TimeoutError")), firstHandshakeMs) : undefined;
    handshakeTimer?.unref();
    const attemptSignal = AbortSignal.any([signal, handshakeController.signal]);
    let httpFailure: DmsHttpFailure | undefined, backoff: number | undefined;
    const transport = new SSEClientTransport(target, {
      fetch: sameOriginFetch(target.origin, attemptSignal, failure => { httpFailure = failure; }),
      requestInit: { headers },
    });
    const candidate = new Client({ name: "issue-pilot", version: "0.1.0" });
    let cancellation: ReturnType<typeof addAbortListener> | undefined;
    try {
      attemptSignal.throwIfAborted();
      await Promise.race([candidate.connect(transport), new Promise<never>((_, reject) => {
        cancellation = addAbortListener(attemptSignal, () => reject(attemptSignal.reason));
      })]);
      if (signal.aborted) throw signal.reason;
      client = candidate;
      break;
    } catch {
      await transport.close().catch(() => undefined);
      if (signal.aborted) throw cancellationError(signal);
      if (httpFailure) {
        const minimumDelay = httpFailure.retryAfterMs ?? limits.retryDelayMs;
        if (attempt === 0 && httpFailure.status === 429 && minimumDelay <= limits.maxRetryDelayMs) {
          backoff = minimumDelay + Math.floor(Math.random() * Math.min(limits.retryDelayMs, limits.maxRetryDelayMs - minimumDelay));
        } else throw new DmsHttpError(httpFailure);
      } else {
        if (attempt === 0 && attemptSignal.aborted && attemptSignal.reason instanceof Error && attemptSignal.reason.name === "TimeoutError") continue;
        if (attemptSignal.aborted && attemptSignal.reason instanceof Error && attemptSignal.reason.name === "TimeoutError") throw new Error("dms_mcp_timeout");
        throw new Error("dms_mcp_connection_failed");
      }
    } finally {
      cancellation?.[Symbol.dispose]();
      clearTimeout(handshakeTimer);
    }
    if (backoff !== undefined) {
      try { await delay(backoff, undefined, { signal }); }
      catch { throw cancellationError(signal); }
    }
  }
  if (!client) throw new Error("dms_mcp_timeout");
  const connectedClient = client;
  return {
    async listTools(requestSignal) {
      const tools: DmsMcpTool[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = await connectedClient.listTools(cursor ? { cursor } : undefined, { signal: requestSignal, timeout: limits.executionMs, maxTotalTimeout: limits.executionMs });
        tools.push(...result.tools as DmsMcpTool[]);
        cursor = result.nextCursor;
        if (cursor && (cursor.length > 1024 || cursors.has(cursor))) throw new Error("dms_mcp_invalid_cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return tools;
    },
    async callTool(name, args, requestSignal) {
      return connectedClient.callTool({ name, arguments: args }, undefined, { signal: requestSignal, timeout: limits.executionMs, maxTotalTimeout: limits.executionMs });
    },
    close: () => connectedClient.close(),
  };
}

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
  databaseId: string;
}

export async function resolveDmsScope(configured: DmsConnectionConfiguration, instanceAlias: string, schemaName: string, signal?: AbortSignal, connect: ConnectDmsMcp = connectDmsMcp): Promise<DmsScopeResolution> {
  const boundedSignal = operationSignal(signal);
  const session = await connect(configured, boundedSignal);
  return withDmsSession(session, boundedSignal, async () => {
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
    return { instanceId, instanceHost, instancePort, databaseId };
  });
}

const resolvedFileTargets = new WeakMap<object, { url: string; authorization: string; targets: Map<string, DmsScopeResolution> }>();

async function resolveFileTarget(configured: CapabilityConfig<"dms">, database: CapabilityConfig<"dms">["databases"][number], signal: AbortSignal, connect: ConnectDmsMcp): Promise<DmsScopeResolution> {
  let cache = resolvedFileTargets.get(configured);
  if (!cache || cache.url !== configured.url || cache.authorization !== configured.authorization) {
    cache = { url: configured.url, authorization: configured.authorization, targets: new Map() };
    resolvedFileTargets.set(configured, cache);
  }
  const key = JSON.stringify([database.instanceAlias, database.schemaName]);
  const existing = cache.targets.get(key);
  if (existing) return existing;
  // Cache only completed metadata, never share a caller's in-flight cancellation.
  const resolved = await resolveDmsScope(configured, database.instanceAlias, database.schemaName, signal, connect);
  cache.targets.set(key, resolved);
  return resolved;
}

export async function queryDms(
  input: CapabilityInputs["dms"],
  configured: CapabilityConfig<"dms">,
  signal?: AbortSignal,
  connect: ConnectDmsMcp = connectDmsMcp,
  outputStore?: IssueOutputStore,
) {
  if (input.output) {
    if (!outputStore) throw new Error("issue_output_not_available");
    outputFileName(input.output.fileName);
    if (!/\.json$/i.test(input.output.fileName)) throw new Error("dms_output_json_required");
  }
  const database = configured.databases.find(({ schemaName }) => schemaName === input.schema);
  if (!database) throw new Error("dms_database_not_authorized");
  const boundedSignal = operationSignal(signal);
  const args = executeScriptArguments(input, database.databaseId);
  const started = performance.now();
  const phaseElapsedMs: DmsDiagnostics["phaseElapsedMs"] = {};
  let failedPhase: DmsPhase | undefined;
  let sqlDispatchAttempted = false;
  let httpError: DmsHttpError | undefined;
  const phase = async <T>(name: DmsPhase, operation: () => Promise<T>): Promise<T> => {
    const phaseStarted = performance.now();
    try { return await operation(); }
    catch (error) {
      failedPhase ??= name;
      if (error instanceof DmsHttpError) httpError ??= error;
      throw error;
    } finally { phaseElapsedMs[name] = Math.round(performance.now() - phaseStarted); }
  };
  try {
    const session = await phase("connect", async () => {
      if (!database.databaseId) {
        const resolved = await resolveFileTarget(configured, database, boundedSignal, connect);
        args.database_id = resolved.databaseId;
      }
      return connect(configured, boundedSignal);
    });
    return await withDmsSession({ close: () => phase("close", () => session.close()) }, boundedSignal, async (close) => {
      const tool = uniqueTool(await phase("discovery", () => session.listTools(boundedSignal)), "executeScript", isReadOnlyScriptTool);
      if (!tool) { failedPhase = "discovery"; throw new Error("dms_mcp_execute_script_unavailable"); }
      const result = await phase("execute", async () => {
        // This records a dispatch attempt, not proof the server received or executed SQL.
        sqlDispatchAttempted = true;
        const response = await session.callTool(tool.name, args, boundedSignal);
        if (response && typeof response === "object" && "isError" in response && response.isError === true) throw new Error("dms_mcp_tool_failed");
        boundedSignal.throwIfAborted();
        return response;
      });
      const text = JSON.stringify({ tool: tool.name, result }, null, 2);
      if (input.output) {
        const output = await phase("publish", () => outputStore!.generate(input.output!.fileName, async (append) => { await append(text); await close(); boundedSignal.throwIfAborted(); }, boundedSignal));
        return capabilityTextResult(JSON.stringify({ tool: tool.name, output: { fileName: output.fileName, size: output.size, format: "dms-mcp-json", downloadPath: outputStore!.downloadPath(output.fileName) } }), { provider: "aliyun-dms-mcp", tool: tool.name, fileName: output.fileName });
      }
      return capabilityTextResult(text, { provider: "aliyun-dms-mcp", tool: tool.name });
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new DmsOperationError({
      phase: failedPhase ?? "execute",
      elapsedMs: Math.round(performance.now() - started),
      phaseElapsedMs,
      sqlDispatchAttempted,
      ...(httpError?.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: httpError.retryAfterSeconds }),
    }, boundedSignal.aborted ? cancellationError(boundedSignal) : error);
  }
}
