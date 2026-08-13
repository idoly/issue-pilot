import { issuePilotConfig } from "../../issue-pilot.config.ts";

export async function boundedResponseText(response: Response, maximum = issuePilotConfig.limits.capability.resultBytes): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) throw new Error("capability_result_too_large");
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function responseJson(response: Response): Promise<unknown> {
  const text = await boundedResponseText(response);
  if (!response.ok) throw new Error(`external_http_${response.status}`);
  return text ? JSON.parse(text) as unknown : null;
}

export function basicAuthHeaders(config: Record<string, unknown>): Record<string, string> {
  return config.username ? { authorization: `Basic ${Buffer.from(`${config.username}:${config.password ?? ""}`).toString("base64")}` } : {};
}
