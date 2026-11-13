import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { applicationSettings } from "../db/schema.ts";
import type { IssueSearchConfiguration, IssueSearchSettings } from "../search/contracts.ts";
import { ApiError, checkRevision, closedRecord, text } from "./input.ts";

export async function loadIssueSearchSettings(database: Pick<Database, "select">): Promise<IssueSearchSettings> {
  const [row] = await database.select({ search: applicationSettings.issueSearch }).from(applicationSettings).where(eq(applicationSettings.id, 1)).limit(1);
  return row?.search ?? { revision: 0, enabled: false, accountId: "", apiToken: "" };
}

export function projectIssueSearchSettings({ apiToken, ...state }: IssueSearchSettings): IssueSearchConfiguration {
  return { ...state, tokenConfigured: Boolean(apiToken) };
}

/** The caller owns the configuration scope and cancels active searches after commit. */
export async function updateIssueSearchSettings(database: Pick<Database, "select" | "insert">, payload: unknown) {
  const input = closedRecord(payload, ["expectedRevision", "enabled", "accountId", "apiToken"], "invalid_issue_search_configuration");
  if (typeof input.enabled !== "boolean" || typeof input.accountId !== "string" || input.expectedRevision === undefined) throw new ApiError(400, "invalid_issue_search_configuration");
  const enabled = input.enabled;
  const accountId = input.accountId.trim().toLowerCase();
  if (accountId && !/^[0-9a-f]{32}$/.test(accountId)) throw new ApiError(400, "invalid_issue_search_account_id");
  const token = input.apiToken === undefined || input.apiToken === null ? input.apiToken : text(input.apiToken, "issue_search_token", 1024);
  if (typeof token === "string" && !/^[!-~]+$/.test(token)) throw new ApiError(400, "invalid_issue_search_token");
  const current = await loadIssueSearchSettings(database);
  checkRevision(input.expectedRevision, current.revision);
  if (token === undefined && accountId !== current.accountId && current.apiToken) throw new ApiError(400, "issue_search_account_token_required");
  const apiToken = token === undefined && accountId === current.accountId ? current.apiToken : (token ?? "");
  if ((enabled && (!accountId || !apiToken)) || (apiToken && !accountId)) throw new ApiError(400, "issue_search_credentials_required");
  if (enabled === current.enabled && accountId === current.accountId && apiToken === current.apiToken) return { settings: current, changed: false };
  const search = { enabled, accountId, apiToken, revision: current.revision + 1 };
  await database
    .insert(applicationSettings)
    .values({ id: 1, issueSearch: search })
    .onConflictDoUpdate({ target: applicationSettings.id, set: { issueSearch: search } });
  return { settings: search, changed: true };
}
