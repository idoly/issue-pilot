import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { ToolRuntime } from "../tool-runtime.ts";
import { isDmsDatabaseId, isDmsTenantId } from "../domain/contracts.ts";
import type { IssuePolicy } from "../pi/policy.ts";
import { runAliyunCli, withAliyunCliProfile } from "./aliyun.ts";
import { capabilityResultText, capabilityTextResult } from "./contracts.ts";
import { validateReadOnlySql } from "./sql.ts";

const limits = issuePilotConfig.limits.capability.dms;

interface DmsRuntime {
  endpoint: string;
  cliRegion: string;
}

interface DmsScriptResult {
  ColumnNames: string[];
  Rows: Array<Record<string, unknown>>;
  Success: boolean;
  Message?: string;
  RowCount: number;
}

interface SqlToken {
  value: string;
  start: number;
  end: number;
}

function topLevelTokens(statement: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let tokenStart = -1;
  let quote = "";
  let depth = 0;
  const flush = (end: number) => {
    if (tokenStart < 0) return;
    tokens.push({ value: statement.slice(tokenStart, end), start: tokenStart, end });
    tokenStart = -1;
  };
  for (let index = 0; index < statement.length; index += 1) {
    const character = statement[index]!;
    if (quote) {
      if (character === quote) {
        if (statement[index + 1] === quote) index += 1;
        else quote = "";
      } else if (character === "\\" && quote !== "]") index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") { flush(index); quote = character; continue; }
    if (character === "[") { flush(index); quote = "]"; continue; }
    if (character === "(") { flush(index); depth += 1; continue; }
    if (character === ")") { flush(index); depth -= 1; if (depth < 0) throw new Error("invalid_database_query"); continue; }
    if (depth > 0) continue;
    if (/[a-zA-Z0-9_]/.test(character)) { if (tokenStart < 0) tokenStart = index; }
    else flush(index);
  }
  if (quote || depth !== 0) throw new Error("invalid_database_query");
  flush(statement.length);
  return tokens;
}

export function validateDmsQuery(query: string): string {
  const statement = validateReadOnlySql(query, limits.queryChars);
  if (/^select\b/i.test(statement)) {
    const tokens = topLevelTokens(statement);
    const limitToken = tokens.at(-2);
    const valueToken = tokens.at(-1);
    const exactLimitSyntax = limitToken?.value.toLowerCase() === "limit" && valueToken && /^[0-9]+$/.test(valueToken.value)
      && /^\s+$/.test(statement.slice(limitToken.end, valueToken.start)) && /^\s*$/.test(statement.slice(valueToken.end));
    const rowLimit = exactLimitSyntax ? Number(valueToken.value) : 0;
    if (rowLimit < 1 || rowLimit > limits.rows) throw new Error("dms_select_requires_bounded_limit");
  }
  return statement;
}

function parseDmsResponse(stdout: string): { requestId: string; result: DmsScriptResult } {
  let response: unknown;
  try { response = JSON.parse(stdout); } catch { throw new Error("dms_query_invalid_response"); }
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("dms_query_invalid_response");
  const body = response as Record<string, unknown>;
  if (body.Success !== true) throw new Error("dms_query_failed");
  if (!Array.isArray(body.Results) || body.Results.length !== 1) throw new Error("dms_query_invalid_response");
  const rawResult = body.Results[0];
  if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) throw new Error("dms_query_invalid_response");
  const result = rawResult as Record<string, unknown>;
  if (result.Success !== true) throw new Error("dms_query_failed");
  if (!Array.isArray(result.ColumnNames) || !result.ColumnNames.every((column) => typeof column === "string")) throw new Error("dms_query_invalid_response");
  if (!Array.isArray(result.Rows)) throw new Error("dms_query_invalid_response");
  const rawRows = result.Rows.length === 1 && Array.isArray(result.Rows[0]) ? result.Rows[0] : result.Rows;
  if (!rawRows.every((row) => row && typeof row === "object" && !Array.isArray(row))) throw new Error("dms_query_invalid_response");
  if (!Number.isSafeInteger(result.RowCount) || result.RowCount !== rawRows.length) throw new Error("dms_query_invalid_response");
  if (rawRows.length > limits.rows) throw new Error("capability_result_too_large");
  return {
    requestId: typeof body.RequestId === "string" ? body.RequestId : "",
    result: {
      ColumnNames: result.ColumnNames,
      Rows: rawRows as Array<Record<string, unknown>>,
      Success: true,
      ...(typeof result.Message === "string" ? { Message: result.Message } : {}),
      RowCount: result.RowCount as number,
    },
  };
}

export async function queryDms(
  tools: ToolRuntime,
  policy: IssuePolicy,
  input: { statement: string },
  configured: Record<string, unknown>,
  signal?: AbortSignal,
  runtime: DmsRuntime = issuePilotConfig.runtime.dms,
) {
  const statement = validateDmsQuery(input.statement);
  const scope = policy.service.dms;
  if (!scope) throw new Error("dms_scope_not_granted_for_service");
  if (configured.dbId !== scope.dbId || configured.logic !== scope.logic || configured.tid !== scope.tid || typeof configured.accessKeyId !== "string" || !configured.accessKeyId || typeof configured.accessKeySecret !== "string" || !configured.accessKeySecret) throw new Error("dms_configuration_changed");
  if (!isDmsDatabaseId(scope.dbId) || (scope.tid !== undefined && !isDmsTenantId(scope.tid))) throw new Error("invalid_dms_service_scope");
  if (runtime.endpoint !== issuePilotConfig.runtime.dms.endpoint || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(runtime.cliRegion)) throw new Error("invalid_dms_runtime");

  return withAliyunCliProfile({
    accessKeyId: configured.accessKeyId,
    accessKeySecret: configured.accessKeySecret,
    region: runtime.cliRegion,
  }, async (profileRoot) => {
    const args = [
      "dms-enterprise", "ExecuteScript",
      "--DbId", scope.dbId,
      "--Logic", String(scope.logic),
      "--Script", statement,
      ...(scope.tid === undefined ? [] : ["--Tid", scope.tid]),
      "--endpoint", runtime.endpoint,
      "--secure",
    ];
    const execution = await runAliyunCli(tools, profileRoot, args, {
      timeout: limits.executionMs,
      ...(signal ? { signal } : {}),
    });
    if (execution.killed || execution.code !== 0) throw new Error("dms_query_failed");
    const { requestId, result } = parseDmsResponse(execution.stdout);
    const query = { dbId: scope.dbId, logic: scope.logic, ...(scope.tid === undefined ? {} : { tid: scope.tid }), returnedRows: result.RowCount, possiblyIncomplete: false };
    const text = capabilityResultText({ query, columns: result.ColumnNames, rows: result.Rows });
    return capabilityTextResult(text, { provider: "aliyun-dms", deploymentId: scope.deploymentId, requestId, ...query });
  });
}
