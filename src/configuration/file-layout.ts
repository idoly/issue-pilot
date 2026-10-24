import { DINGTALK_COLUMNS, type DingtalkColumns } from "../mcp/dingtalk-contracts.ts";
import type { FileConfigurationState } from "./contracts.ts";

export function managesFileUser(state: FileConfigurationState | undefined, subject: string): boolean {
  return state?.userSubjects?.includes(subject) === true;
}
export function publicFileState(state: FileConfigurationState | undefined, subject: string): FileConfigurationState {
  const { userSubject: _subject, userSubjects: _subjects, ...flags } = state ?? { services: false, mcp: false };
  return { ...flags, ...(managesFileUser(state, subject) ? { userSubject: subject } : {}) };
}

export class FileConfigurationError extends Error {}
const invalid = (): never => { throw new FileConfigurationError("invalid_file_configuration"); };
export function fileRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
export function repositoryAddress(value: unknown): string {
  const url = value;
  if (typeof url !== "string" || !url.trim() || url.includes("\0")) return invalid();
  return url.trim();
}
export interface FileQueryTarget { name: string; value: Record<string, unknown> }
export function queryTargets(kind: "dms" | "sls", value: unknown, singleName = "default"): FileQueryTarget[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (!values.length) return invalid();
  const result = values.map(value => {
    const target = fileRecord(value);
    const name = target.name ?? (kind === "dms" ? target.schema : values.length === 1 ? singleName : undefined);
    if (typeof name !== "string" || !name.trim() || name.includes("\0")) throw new FileConfigurationError("query_target_name_required");
    const { name: _name, ...fields } = target;
    return { name: name.trim(), value: fields };
  });
  if (kind === "sls" && new Set(result.map(target => target.name)).size !== result.length) throw new FileConfigurationError("duplicate_query_target_name");
  return result;
}
export interface UserFileLayout { shared: Record<string, unknown>; users: Record<string, Record<string, unknown>> }
export function userFileLayout(input: Record<string, unknown> | undefined): UserFileLayout {
  if (!input) return { shared: {}, users: {} };
  if (input.version !== 2) return invalid();
  return { shared: fileRecord(input.shared ?? {}), users: Object.fromEntries(Object.entries(fileRecord(input.users)).map(([subject, value]) => [subject, fileRecord(value)])) };
}

export function dingtalkFieldConfiguration(value: unknown): Partial<DingtalkColumns> {
  const fields = fileRecord(value ?? {});
  if (Object.keys(fields).some(key => !DINGTALK_COLUMNS.includes(key as keyof DingtalkColumns))) return invalid();
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => {
    if (typeof value !== "string" || value.length > 255 || value.includes("\0")) return invalid();
    return [key, value.trim()];
  }));
}

export function validateDingtalkSource(value: unknown): void {
  if (value === undefined) return;
  const source = fileRecord(value);
  if (Object.keys(source).some(key => !["mcp", "url", "assignee", "intervalMinutes", "environment"].includes(key))) return invalid();
  for (const key of ["mcp", "url", "assignee"]) if (typeof source[key] !== "string" || !source[key].trim() || source[key].includes("\0")) return invalid();
  let url: URL;
  try { url = new URL(source.url as string); } catch { return invalid(); }
  if (url.protocol !== "https:" || url.username || url.password) return invalid();
  if (source.intervalMinutes !== undefined && (!Number.isSafeInteger(source.intervalMinutes) || Number(source.intervalMinutes) < 1)) return invalid();
  if (source.environment !== undefined && !["dev", "test", "prod"].includes(String(source.environment))) return invalid();
}
