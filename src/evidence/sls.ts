import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { result } from "./output.ts";

const PROJECT = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const LOGSTORE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,61}[a-zA-Z0-9]$/;
const MAX_QUERY_LENGTH = 4096;
const MAX_WINDOW_SECONDS = 24 * 60 * 60;
const TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function secureFile(file: string, secret: boolean): Promise<void> {
  const metadata = await stat(file);
  const forbiddenMode = secret ? 0o077 : 0o022;
  if (!metadata.isFile() || (metadata.mode & forbiddenMode) !== 0) throw new Error(secret ? "insecure_aliyun_config_file" : "insecure_aliyun_cli_file");
}

export async function readSlsLogs(pi: ExtensionAPI, input: {
  project: string;
  logstore: string;
  from?: number;
  to?: number;
  query?: string;
  trace_id?: string;
  limit?: number;
}, signal?: AbortSignal) {
  if (!PROJECT.test(input.project)) throw new Error("invalid_sls_project");
  if (!LOGSTORE.test(input.logstore)) throw new Error("invalid_sls_logstore");
  if ((input.from === undefined) !== (input.to === undefined)) throw new Error("invalid_sls_time_range");
  const now = Math.floor(Date.now() / 1000);
  const to = input.to ?? now;
  const from = input.from ?? to - (input.trace_id ? MAX_WINDOW_SECONDS : 15 * 60);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to - from > MAX_WINDOW_SECONDS) throw new Error("invalid_sls_time_range");
  if (to > now + 300) throw new Error("invalid_sls_time_range");
  const traceId = input.trace_id?.trim();
  if (traceId && !TRACE_ID.test(traceId)) throw new Error("invalid_sls_trace_id");
  if (traceId && input.query?.trim()) throw new Error("invalid_sls_query");
  const query = traceId || input.query?.trim() || "*";
  if (query.length > MAX_QUERY_LENGTH || query.includes("\0")) throw new Error("invalid_sls_query");
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_sls_limit");

  const configFile = process.env.ISSUE_PILOT_ALIYUN_CONFIG_FILE ?? path.join(os.homedir(), ".aliyun", "config.json");
  const cli = process.env.ISSUE_PILOT_ALIYUN_CLI ?? "/usr/local/sbin/aliyun";
  const plugin = path.join(path.dirname(configFile), "plugins", "aliyun-cli-sls", "aliyun-cli-sls");
  await Promise.all([secureFile(configFile, true), secureFile(cli, false), secureFile(plugin, false)]);

  const execution = await pi.exec(cli, [
    "sls", "get-logs",
    "--project", input.project,
    "--logstore", input.logstore,
    "--from", String(from),
    "--to", String(to),
    "--query", query,
    "--line", String(limit),
    "--offset", "0",
    "--reverse", "true",
  ], { timeout: 30_000, ...(signal ? { signal } : {}) });
  if (execution.code !== 0) throw new Error("sls_query_failed");
  if (Buffer.byteLength(execution.stdout, "utf8") > 2 * 1024 * 1024) throw new Error("sls_query_output_too_large");
  let parsed: unknown;
  try { parsed = JSON.parse(execution.stdout); } catch { throw new Error("sls_query_invalid_response"); }
  return result(parsed, { provider: "aliyun-sls", project: input.project, logstore: input.logstore, from, to, limit, queryMode: traceId ? "trace_id" : "query", runtime: "local-cli" });
}
