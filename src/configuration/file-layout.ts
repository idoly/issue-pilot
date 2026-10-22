import type { FileConfigurationState } from "./contracts.ts";
import { isDeepStrictEqual } from "node:util";

export function managesFileUser(state: FileConfigurationState | undefined, subject: string): boolean {
  return state?.userSubject === subject || state?.userSubjects?.includes(subject) === true;
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
export function serviceVersion(value: Record<string, unknown> | undefined): number {
  const version = value?.version ?? 1;
  if (![1, 2, 3].includes(Number(version))) return invalid();
  return Number(version);
}
export function repositoryAddress(value: unknown, version: number): string {
  const url = version === 2 ? value : fileRecord(value).url;
  if (typeof url !== "string" || !url.trim() || url.includes("\0")) return invalid();
  return url.trim();
}
export interface FileQueryTarget { name: string; value: Record<string, unknown> }
export function queryTargets(kind: "dms" | "sls", value: unknown, version: number, singleName = "default"): FileQueryTarget[] {
  if (value === undefined) return [];
  if (version !== 2) return Object.entries(fileRecord(value)).map(([name, value]) => ({ name, value: fileRecord(value) }));
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
export function simpleTargets(kind: "dms" | "sls", targets: FileQueryTarget[], singleName = "default"): unknown {
  if (!targets.length) return invalid();
  if (targets.length === 1) return kind === "sls" && targets[0]!.name !== singleName ? { name: targets[0]!.name, ...targets[0]!.value } : { ...targets[0]!.value };
  return targets.map(target => kind === "sls" ? { name: target.name, ...target.value } : { ...target.value });
}
export function simpleServiceFile(input: Record<string, unknown>): Record<string, unknown> {
  const version = serviceVersion(input), result = structuredClone(input);
  result.version = 2;
  result.repositories = Object.fromEntries(Object.entries(fileRecord(input.repositories ?? {})).map(([alias, value]) => {
    if (version !== 2 && Object.keys(fileRecord(value)).some(key => key !== "url")) throw new FileConfigurationError("repository_metadata_requires_review");
    return [alias, repositoryAddress(value, version)];
  }));
  for (const raw of Object.values(fileRecord(result.services ?? {}))) {
    for (const [environment, value] of Object.entries(fileRecord(fileRecord(raw).environments))) {
      const scope = fileRecord(value);
      for (const kind of ["dms", "sls"] as const) if (scope[kind] !== undefined) scope[kind] = simpleTargets(kind, queryTargets(kind, scope[kind], version, environment), environment);
    }
  }
  return result;
}
export interface UserFileLayout { shared: Record<string, unknown>; users: Record<string, Record<string, unknown>> }
export function userFileLayout(input: Record<string, unknown> | undefined): UserFileLayout {
  if (!input) return { shared: {}, users: {} };
  if (input.version === 2) return { shared: fileRecord(input.shared ?? {}), users: Object.fromEntries(Object.entries(fileRecord(input.users)).map(([subject, value]) => [subject, fileRecord(value)])) };
  if (input.version !== undefined && input.version !== 1) return invalid();
  const subject = fileRecord(input.user).subject;
  if (typeof subject !== "string" || !subject.trim()) return invalid();
  const { version: _version, user: _user, ...personal } = input;
  const shared = Object.fromEntries(["sls", "dms", "dingtalk"].flatMap(key => {
    if (personal[key] === undefined) return [];
    const { source: _source, ...connection } = fileRecord(personal[key]);
    return Object.keys(connection).length ? [[key, connection]] : [];
  }));
  return { shared, users: { [subject.trim()]: personal } };
}
export function moveDingtalkSource(service: Record<string, unknown>, users: Record<string, Record<string, unknown>>, subject: string): void {
  if (service.sources === undefined) return;
  const sources = fileRecord(service.sources);
  if (Object.keys(sources).some(name => name !== "dingtalk")) throw new FileConfigurationError("source_migration_requires_review");
  if (sources.dingtalk !== undefined) {
    const user = users[subject];
    if (!user) throw new FileConfigurationError("source_owner_required");
    const dingtalk = fileRecord(user.dingtalk ?? {}), source = fileRecord(sources.dingtalk);
    if (dingtalk.source !== undefined && !isDeepStrictEqual(dingtalk.source, source)) throw new FileConfigurationError("conflicting_dingtalk_sources");
    user.dingtalk = { ...dingtalk, source };
  }
  delete service.sources;
}
export function fillMissingUserCredentials(users: Record<string, Record<string, unknown>>, sourceSubject: string): Record<string, number> {
  const source = Object.hasOwn(users, sourceSubject) ? users[sourceSubject] : undefined;
  if (!source) throw new FileConfigurationError("credential_source_user_missing");
  const filled = { apiKeys: 0, ssh: 0, dms: 0, sls: 0, dingtalk: 0 };
  const sourceKeys = fileRecord(source.apiKeys ?? {});
  for (const user of Object.values(users)) {
    if (user === source) continue;
    const keys = fileRecord(user.apiKeys ?? {});
    const missing = Object.entries(sourceKeys).filter(([provider, value]) => typeof value === "string" && value.trim() && (!Object.hasOwn(keys, provider) || keys[provider] === null || keys[provider] === undefined || keys[provider] === ""));
    filled.apiKeys += missing.length;
    user.apiKeys = Object.fromEntries([...Object.entries(keys), ...missing]);
    for (const [group, fields] of [["ssh", ["privateKey"]], ["dms", ["url", "authorization"]], ["sls", ["accessKeyId", "accessKeySecret"]], ["dingtalk", ["apiKey"]]] as const) {
      const origin = fileRecord(source[group] ?? {}), current = fileRecord(user[group] ?? {});
      if (!fields.every(field => typeof origin[field] === "string" && String(origin[field]).trim()) || fields.every(field => typeof current[field] === "string" && String(current[field]).trim())) continue;
      if (fields.some(field => Boolean(current[field]))) throw new FileConfigurationError("incomplete_user_credentials_require_review");
      if (group === "dingtalk") {
        const { source: _source, ...connection } = origin;
        user[group] = { ...current, ...connection };
      } else user[group] = origin;
      filled[group]++;
    }
  }
  return filled;
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
