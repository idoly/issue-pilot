import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { capabilitySignal, isNacosTarget } from "./contracts.ts";
import { boundedResponseText } from "./http-client.ts";

const limits = issuePilotConfig.limits.capability;

export interface NacosConnection {
  serverUrl: string;
  namespace: string;
  group: string;
  username: string;
  password: string;
  dataIds: string[];
}

function nacosOrigin(value: string): string {
  const server = new URL(value.includes("://") ? value : `http://${value}`);
  if (!["http:", "https:"].includes(server.protocol) || !server.hostname || server.username || server.password || server.search || server.hash || !["", "/"].includes(server.pathname)) throw new Error("invalid_nacos_server");
  if (!server.port) server.port = server.protocol === "https:" ? "443" : "8848";
  return server.origin;
}

async function nacosAccessToken(origin: string, connection: NacosConnection, signal: AbortSignal): Promise<string> {
  if (!connection.username) return "";
  const response = await fetch(new URL("/nacos/v1/auth/login", origin), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: connection.username, password: connection.password }),
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

export async function readNacosConfigurations(connection: NacosConnection, signal?: AbortSignal): Promise<Array<{ dataId: string; group: string; content: string | null }>> {
  if (!isNacosTarget(connection.group)
    || !Array.isArray(connection.dataIds)
    || !connection.dataIds.length
    || connection.dataIds.length > limits.nacos.dataIds
    || connection.dataIds.some((dataId) => !isNacosTarget(dataId))
    || new Set(connection.dataIds).size !== connection.dataIds.length) throw new Error("invalid_nacos_configuration_target");
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
  return configurations;
}
