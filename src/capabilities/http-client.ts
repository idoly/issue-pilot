import { issuePilotConfig } from "../../issue-pilot.config.ts";

export async function boundedResponseText(response: Response, maximum = issuePilotConfig.limits.capability.resultBytes): Promise<string> {
  if (!response.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maximum) throw new Error("capability_result_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export async function responseJson(response: Response): Promise<unknown> {
  const text = await boundedResponseText(response);
  if (!response.ok) throw new Error(`external_http_${response.status}`);
  return text ? JSON.parse(text) as unknown : null;
}

export function basicAuthHeaders(config: { username: string; password?: string }): Record<string, string> {
  return config.username ? { authorization: `Basic ${Buffer.from(`${config.username}:${config.password ?? ""}`).toString("base64")}` } : {};
}
