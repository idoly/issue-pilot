import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { capabilityResultText, capabilitySignal, capabilityTextResult } from "./contracts.ts";
import { boundedResponseText } from "./http-client.ts";
import type { CapabilityConfig } from "./registry.ts";

const limits = issuePilotConfig.limits.capability;

function nacosOrigin(value: string): string {
  const server = new URL(value);
  if (!server.port) server.port = server.protocol === "https:" ? "443" : "8848";
  return server.origin;
}

async function nacosAccessToken(origin: string, connection: CapabilityConfig<"nacos">, signal: AbortSignal): Promise<string> {
  if (!connection.username) return "";
  const response = await fetch(new URL("/nacos/v1/auth/login", origin), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: connection.username, password: connection.password ?? "" }),
    redirect: "error",
    signal,
  });
  const text = await boundedResponseText(response, limits.nacos.loginResponseBytes);
  if (!response.ok) throw new Error(`nacos_login_failed:${response.status}`);
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { throw new Error("nacos_login_response_invalid"); }
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const tokenData = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : {};
  const token = typeof record.accessToken === "string" ? record.accessToken : typeof tokenData.accessToken === "string" ? tokenData.accessToken : "";
  if (!token) throw new Error("nacos_login_token_missing");
  return token;
}

export async function readNacos(connection: CapabilityConfig<"nacos">, signal?: AbortSignal) {
  const origin = nacosOrigin(connection.serverUrl);
  const activeSignal = capabilitySignal(signal);
  const accessToken = await nacosAccessToken(origin, connection, activeSignal);
  const configurations: Array<{ dataId: string; group: string; content: string | null }> = [];
  let remainingBytes = limits.resultBytes;
  for (const dataId of connection.dataIds) {
    const endpoint = new URL("/nacos/v1/cs/configs", origin);
    endpoint.searchParams.set("dataId", dataId);
    endpoint.searchParams.set("group", connection.group);
    if (connection.namespace) endpoint.searchParams.set("tenant", connection.namespace);
    if (accessToken) endpoint.searchParams.set("accessToken", accessToken);
    const response = await fetch(endpoint, { redirect: "error", signal: activeSignal });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      configurations.push({ dataId, group: connection.group, content: null });
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`nacos_configuration_read_failed:${response.status}`);
    }
    const content = await boundedResponseText(response, remainingBytes);
    remainingBytes -= Buffer.byteLength(content);
    configurations.push({ dataId, group: connection.group, content });
  }
  return capabilityTextResult(capabilityResultText({ configurations }), {});
}
