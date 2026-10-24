import { isDeepStrictEqual } from "node:util";
import { FileConfigurationError, fileRecord, queryTargets, repositoryAddress, userFileLayout, type FileQueryTarget, type UserFileLayout } from "../src/configuration/file-layout.ts";

const invalid = (): never => { throw new FileConfigurationError("invalid_file_configuration"); };

/** Legacy formats are converted only by the explicit offline preparation command. */
export function convertServiceFile(input: Record<string, unknown>): Record<string, unknown> {
  const version = Number(input.version ?? 1);
  if (![1, 2, 3].includes(version)) return invalid();
  const result = structuredClone(input);
  result.version = 2;
  result.repositories = Object.fromEntries(Object.entries(fileRecord(input.repositories ?? {})).map(([alias, value]) => {
    if (version !== 2 && Object.keys(fileRecord(value)).some(key => key !== "url")) throw new FileConfigurationError("repository_metadata_requires_review");
    return [alias, repositoryAddress(version === 2 ? value : fileRecord(value).url)];
  }));
  for (const raw of Object.values(fileRecord(result.services ?? {}))) {
    for (const [environment, value] of Object.entries(fileRecord(fileRecord(raw).environments))) {
      const scope = fileRecord(value);
      for (const kind of ["dms", "sls"] as const) if (scope[kind] !== undefined) {
        const targets = version === 2 ? queryTargets(kind, scope[kind], environment)
          : Object.entries(fileRecord(scope[kind])).map(([name, value]) => ({ name, value: fileRecord(value) }));
        scope[kind] = simpleTargets(kind, targets, environment);
      }
    }
  }
  return result;
}

export function simpleTargets(kind: "dms" | "sls", targets: FileQueryTarget[], singleName = "default"): unknown {
  if (!targets.length) return invalid();
  if (targets.length === 1) return kind === "sls" && targets[0]!.name !== singleName ? { name: targets[0]!.name, ...targets[0]!.value } : { ...targets[0]!.value };
  return targets.map(target => kind === "sls" ? { name: target.name, ...target.value } : { ...target.value });
}

export function convertUserFile(input: Record<string, unknown> | undefined): UserFileLayout {
  let layout: UserFileLayout;
  if (!input || input.version === 2) layout = structuredClone(userFileLayout(input));
  else {
    if (input.version !== undefined && input.version !== 1) return invalid();
    const subject = fileRecord(input.user).subject;
    if (typeof subject !== "string" || !subject.trim()) return invalid();
    const { version: _version, user: _user, ...personal } = structuredClone(input);
    const shared = Object.fromEntries(["sls", "dms", "dingtalk"].flatMap(key => {
      if (personal[key] === undefined) return [];
      const { source: _source, ...connection } = fileRecord(personal[key]);
      return Object.keys(connection).length ? [[key, connection]] : [];
    }));
    layout = { shared, users: { [subject.trim()]: personal } };
  }
  for (const user of Object.values(layout.users)) if (user.dingtalk !== undefined) {
    const { apiKey: _apiKey, url: _url, ...preferences } = fileRecord(user.dingtalk);
    user.dingtalk = preferences;
  }
  return layout;
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
  const filled = { apiKeys: 0, ssh: 0, dms: 0, sls: 0 };
  const sourceKeys = fileRecord(source.apiKeys ?? {});
  for (const user of Object.values(users)) {
    if (user === source) continue;
    const keys = fileRecord(user.apiKeys ?? {});
    const missing = Object.entries(sourceKeys).filter(([provider, value]) => typeof value === "string" && value.trim() && (!Object.hasOwn(keys, provider) || keys[provider] === null || keys[provider] === undefined || keys[provider] === ""));
    filled.apiKeys += missing.length;
    user.apiKeys = Object.fromEntries([...Object.entries(keys), ...missing]);
    for (const [group, fields] of [["ssh", ["privateKey"]], ["dms", ["url", "authorization"]], ["sls", ["accessKeyId", "accessKeySecret"]]] as const) {
      const origin = fileRecord(source[group] ?? {}), current = fileRecord(user[group] ?? {});
      if (!fields.every(field => typeof origin[field] === "string" && String(origin[field]).trim()) || fields.every(field => typeof current[field] === "string" && String(current[field]).trim())) continue;
      if (fields.some(field => Boolean(current[field]))) throw new FileConfigurationError("incomplete_user_credentials_require_review");
      user[group] = origin;
      filled[group]++;
    }
  }
  return filled;
}
