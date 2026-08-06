import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { IssuePolicy } from "../pi/policy.ts";
import { fileURLToPath } from "node:url";

const PROJECT = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const LOGSTORE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,61}[a-zA-Z0-9]$/;
const DEFAULT_TRACE_WINDOW_SECONDS = 24 * 60 * 60;
const TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function secureFile(file: string, secret: boolean): Promise<void> {
  const metadata = await stat(file);
  const forbiddenMode = secret ? 0o077 : 0o022;
  if (!metadata.isFile() || (metadata.mode & forbiddenMode) !== 0) throw new Error(secret ? "insecure_aliyun_config_file" : "insecure_aliyun_cli_file");
}

export async function readSlsLogs(pi: ExtensionAPI, policy: IssuePolicy, input: {
  project: string;
  logstore: string;
  from?: number;
  to?: number;
  query?: string;
  trace_id?: string;
  limit?: number;
}, configured: Record<string, unknown>, signal?: AbortSignal) {
  if (!PROJECT.test(input.project)) throw new Error("invalid_sls_project");
  if (!LOGSTORE.test(input.logstore)) throw new Error("invalid_sls_logstore");
  if ((input.from === undefined) !== (input.to === undefined)) throw new Error("invalid_sls_time_range");
  const now = Math.floor(Date.now() / 1000);
  const to = input.to ?? now;
  const from = input.from ?? to - (input.trace_id ? DEFAULT_TRACE_WINDOW_SECONDS : 15 * 60);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from) throw new Error("invalid_sls_time_range");
  if (to > now + 300) throw new Error("invalid_sls_time_range");
  const traceId = input.trace_id?.trim();
  if (traceId && !TRACE_ID.test(traceId)) throw new Error("invalid_sls_trace_id");
  if (traceId && input.query?.trim()) throw new Error("invalid_sls_query");
  const searchQuery = traceId || input.query?.trim() || "*";
  if (searchQuery.includes("\0")) throw new Error("invalid_sls_query");
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("invalid_sls_limit");

  const scope = policy.service.sls;
  if (!scope) throw new Error("sls_scope_not_granted_for_service");
  if (configured.region !== scope.region || configured.project !== scope.project || !Array.isArray(configured.logstores) || !configured.logstores.includes(input.logstore) || typeof configured.accessKeyId !== "string" || typeof configured.accessKeySecret !== "string") throw new Error("sls_configuration_changed");
  const installedConfig = process.env.ISSUE_PILOT_ALIYUN_CONFIG_FILE ?? path.join(os.homedir(), ".aliyun", "config.json");
  const cli = process.env.ISSUE_PILOT_ALIYUN_CLI ?? "/usr/local/sbin/aliyun";
  const plugin = path.join(path.dirname(installedConfig), "plugins", "aliyun-cli-sls", "aliyun-cli-sls");
  await Promise.all([secureFile(installedConfig, true), secureFile(cli, false), secureFile(plugin, false)]);
  const profileRoot = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-aliyun-"));
  const aliyunRoot = path.join(profileRoot, ".aliyun");
  await mkdir(aliyunRoot, { mode: 0o700 });
  await writeFile(path.join(aliyunRoot, "config.json"), JSON.stringify({ current: "issue-pilot", profiles: [{ name: "issue-pilot", mode: "AK", region_id: scope.region, output_format: "json", language: "en", site: "China", access_key_id: configured.accessKeyId, access_key_secret: configured.accessKeySecret }] }), { mode: 0o600 });
  await symlink(path.join(path.dirname(installedConfig), "plugins"), path.join(aliyunRoot, "plugins"));
  try {
    const wrapper = fileURLToPath(new URL("../../infra/aliyun-profile.sh", import.meta.url));
    await secureFile(wrapper, false);
    const execution = await pi.exec(wrapper, [profileRoot, cli,
      "sls", "get-logs",
      "--endpoint", `${scope.region}.log.aliyuncs.com`,
      "--project", input.project,
      "--logstore", input.logstore,
      "--from", String(from),
      "--to", String(to),
      "--query", searchQuery,
      "--line", String(limit),
      "--offset", "0",
      "--reverse", "true",
    ], { timeout: 30_000, ...(signal ? { signal } : {}) });
    if (execution.code !== 0) throw new Error("sls_query_failed");
    let parsed: unknown;
    try { parsed = JSON.parse(execution.stdout); } catch { throw new Error("sls_query_invalid_response"); }
    const returnedRows = Array.isArray(parsed) ? parsed.length : null;
    const queryMetadata = {
      project: input.project,
      logstore: input.logstore,
      from,
      to,
      timezone: "Asia/Shanghai",
      queryMode: traceId ? "trace_id_full_text" : "query",
      order: "newest_first",
      limit,
      returnedRows,
      possiblyIncomplete: returnedRows === null || returnedRows >= limit,
      truncated: false,
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ query: queryMetadata, records: parsed }, null, 2) }],
      details: { provider: "aliyun-sls", ...queryMetadata, runtime: "local-cli" },
    };
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
  }
}
