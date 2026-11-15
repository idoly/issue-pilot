import type { mcpServices } from "../db/schema.ts";
import { MCP_TRANSPORTS, type McpStdioConfiguration } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import { choice, record, text } from "../domain/input.ts";
type McpRow = typeof mcpServices.$inferSelect;
export function publicMcpUrl(value: string): string {
  if (!value) return "";
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.toString();
}
function parseStdio(value: unknown): McpStdioConfiguration {
  const input = record(value),
    command = text(input.command, "mcp_command", 4096);
  if (command.includes("\0") || (input.args !== undefined && !Array.isArray(input.args))) throw new DomainError("invalid_mcp_stdio", "bad_request");
  const args = ((input.args ?? []) as unknown[]).map((arg) => {
    if (typeof arg !== "string" || arg.includes("\0")) throw new DomainError("invalid_mcp_stdio", "bad_request");
    return arg;
  });
  const env = Object.fromEntries(
    Object.entries(record(input.env === undefined ? {} : input.env)).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")) throw new DomainError("invalid_mcp_stdio", "bad_request");
      return [key, value] as const;
    }),
  );
  if (input.cwd === undefined) return { command, args, env };
  const cwd = text(input.cwd, "mcp_cwd", 4096);
  if (cwd.includes("\0")) throw new DomainError("invalid_mcp_stdio", "bad_request");
  return { command, args, env, cwd };
}
export function parseMcpConfiguration(body: unknown, existing?: McpRow) {
  const input = record(body),
    name = text(input.name, "mcp_name", 100);
  const transport = choice(input.transport, "mcp_transport", MCP_TRANSPORTS);
  let url = transport === "stdio" ? "" : text(input.url, "mcp_url", 2048);
  if (transport === "stdio") {
    if (input.url !== undefined && input.url !== "") throw new DomainError("invalid_mcp_url", "bad_request");
  } else {
    let endpoint: URL;
    try {
      endpoint = new URL(url);
    } catch {
      throw new DomainError("invalid_mcp_url", "bad_request");
    }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) throw new DomainError("invalid_mcp_url", "bad_request");
  }
  if (typeof input.enabled !== "boolean" || "authorization" in input || "stdio" in input) throw new DomainError("invalid_mcp_configuration", "bad_request");
  const update = record(input.credentialUpdate);
  let authorization = "",
    stdio: McpStdioConfiguration | null = null;
  if (update.mode === "preserve") {
    if (existing?.transport === transport && url === publicMcpUrl(existing.url)) url = existing.url;
    if (!existing || existing.url !== url || existing.transport !== transport) throw new DomainError("mcp_credentials_target_changed", "bad_request");
    authorization = existing.authorization;
    stdio = existing.stdio;
  } else if (update.mode === "replace") {
    const values = record(update.values);
    if (transport === "stdio") stdio = parseStdio(values.stdio);
    else {
      authorization = text(values.authorization, "mcp_authorization", 10000);
      if (/[\r\n\0]/.test(authorization)) throw new DomainError("invalid_mcp_authorization", "bad_request");
    }
  } else if (update.mode !== "clear") throw new DomainError("invalid_credential_update", "bad_request");
  if (transport === "stdio" && input.enabled && !stdio) throw new DomainError("mcp_stdio_configuration_required", "bad_request");
  return { name, url, transport, enabled: input.enabled, authorization, stdio };
}
export function parseMcpImport(body: unknown, existing?: McpRow) {
  const entries = Object.entries(record(record(body).mcpServers));
  if (!entries.length || (existing && entries.length !== 1)) throw new DomainError("invalid_mcp_servers", "bad_request");
  return entries.map(([name, value]) => {
    const entry = record(value),
      enabled = entry.enabled ?? (entry.disabled === undefined ? (existing?.enabled ?? true) : !entry.disabled);
    if ((entry.enabled !== undefined && typeof entry.enabled !== "boolean") || (entry.disabled !== undefined && typeof entry.disabled !== "boolean"))
      throw new DomainError("invalid_mcp_configuration", "bad_request");
    if ("command" in entry || entry.type === "stdio") {
      if (entry.url !== undefined || (entry.type !== undefined && entry.type !== "stdio")) throw new DomainError("invalid_mcp_configuration", "bad_request");
      if (!("command" in entry) && (entry.args !== undefined || entry.env !== undefined || entry.cwd !== undefined || !existing)) throw new DomainError("invalid_mcp_stdio", "bad_request");
      return parseMcpConfiguration({ name, transport: "stdio", enabled, credentialUpdate: "command" in entry ? { mode: "replace", values: { stdio: entry } } : { mode: "preserve" } }, existing);
    }
    const type = entry.type === undefined ? "http" : entry.type;
    if (!["http", "streamable_http", "streamable-http", "sse"].includes(String(type))) throw new DomainError("invalid_mcp_transport", "bad_request");
    const headers = Object.entries(record(entry.headers ?? {}));
    if (headers.some(([key]) => key.toLowerCase() !== "authorization") || headers.length > 1) throw new DomainError("mcp_headers_not_supported", "bad_request");
    return parseMcpConfiguration(
      {
        name,
        url: entry.url,
        transport: type === "sse" ? "sse" : "streamable_http",
        enabled,
        credentialUpdate: headers.length ? { mode: "replace", values: { authorization: headers[0]![1] } } : { mode: existing && entry.headers === undefined ? "preserve" : "clear" },
      },
      existing,
    );
  });
}
