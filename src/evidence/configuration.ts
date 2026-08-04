import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import YAML from "yaml";

import type { ServiceCapability } from "../pi/policy.ts";
import { redact, sensitive } from "./output.ts";

const execFileAsync = promisify(execFile);
const CONFIG_FILE = /(?:^|\/)(?:application|bootstrap)(?:-[a-zA-Z0-9._-]+)?\.(?:ya?ml|properties)$/;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_CONFIG_FILES = 50;
const MAX_NACOS_TARGETS = 20;
const PLACEHOLDER = /\$\{([^}:]+)(?::([^}]*))?\}/g;

export interface ResolvedConfiguration {
  properties: Record<string, unknown>;
  sources: string[];
  missingSources: string[];
}

function propertiesDocument(content: string): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const separator = line.search(/(?<!\\)[:=]/);
    const key = (separator < 0 ? line : line.slice(0, separator)).trim();
    if (key) output[key] = separator < 0 ? "" : line.slice(separator + 1).trim();
  }
  return output;
}

function flatten(value: unknown, prefix = "", output: Record<string, unknown> = {}): Record<string, unknown> {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => flatten(entry, `${prefix}[${index}]`, output));
    return output;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) flatten(entry, prefix ? `${prefix}.${key}` : key, output);
    return output;
  }
  if (prefix) output[prefix] = value;
  return output;
}

function parse(file: string, content: string): Record<string, unknown> {
  if (file.endsWith(".properties")) return propertiesDocument(content);
  const documents = YAML.parseAllDocuments(content);
  if (documents.some((document) => document.errors.length)) throw new Error("service_configuration_parse_failed");
  return Object.assign({}, ...documents.map((document) => flatten(document.toJS())));
}

function score(file: string, environmentKey: string): number {
  const name = path.basename(file);
  const configuredProfile = name.match(/^(?:application|bootstrap)-(.+)\.(?:ya?ml|properties)$/)?.[1];
  const profile = !configuredProfile ? 0 : configuredProfile === environmentKey ? 20 : 10;
  return profile + (name.startsWith("application") ? 2 : 1);
}

async function git(repository: string, args: string[]): Promise<string> {
  const metadata = await stat(repository);
  if (!metadata.isDirectory()) throw new Error("service_repository_not_available");
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args], { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

async function frozenFiles(service: ServiceCapability): Promise<Array<{ file: string; content: string }>> {
  const names = (await git(service.repositoryPath, ["ls-tree", "-r", "--name-only", service.baseCommit])).split("\n").filter(Boolean);
  const candidates = names.filter((name) => CONFIG_FILE.test(name) && (!name.includes("/") || /^(?:config|src\/main\/resources)\//.test(name)));
  const profiles = new Set([service.environmentKey, ...(service.environmentKind === "production" ? ["prod", "production"] : service.environmentKind === "test" ? ["test"] : ["local", "dev"])]);
  const selected = new Map<string, string>();
  for (let pass = 0; pass < 10; pass += 1) {
    const files = candidates.filter((file) => {
      const profile = path.basename(file).match(/^(?:application|bootstrap)-(.+)\.(?:ya?ml|properties)$/)?.[1];
      return !profile || profiles.has(profile);
    });
    for (const file of files) {
      if (selected.has(file)) continue;
      const content = await git(service.repositoryPath, ["show", `${service.baseCommit}:${file}`]);
      if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error("service_configuration_too_large");
      selected.set(file, content);
    }
    const properties = Object.assign({}, ...[...selected].map(([file, content]) => parse(file, content)));
    const discovered = [value(properties, "spring.profiles.active"), value(properties, "spring.profiles.include")]
      .flatMap((entry) => entry?.split(",") ?? [])
      .map((entry) => entry.trim())
      .filter(Boolean);
    const previousSize = profiles.size;
    for (const profile of discovered) profiles.add(profile);
    if (profiles.size === previousSize) break;
  }
  const output = [...selected].map(([file, content]) => ({ file, content }))
    .sort((left, right) => score(left.file, service.environmentKey) - score(right.file, service.environmentKey) || left.file.localeCompare(right.file));
  if (output.length > MAX_CONFIG_FILES) throw new Error("too_many_service_configuration_files");
  if (output.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0) > MAX_TOTAL_CONFIG_BYTES) throw new Error("service_configuration_too_large");
  return output;
}

function value(properties: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = properties[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate === "number") return String(candidate);
  }
  return undefined;
}

function resolvePlaceholders(properties: Record<string, unknown>, secrets: Record<string, string>): Record<string, unknown> {
  const resolved = { ...properties };
  for (let pass = 0; pass < 20; pass += 1) {
    let changed = false;
    for (const [key, entry] of Object.entries(resolved)) {
      if (typeof entry !== "string") continue;
      const next = entry.replace(PLACEHOLDER, (match, name: string, fallback: string | undefined) => {
        const replacement = resolved[name];
        if (typeof replacement === "string" || typeof replacement === "number" || typeof replacement === "boolean") return String(replacement);
        if (secrets[name] !== undefined) return secrets[name];
        return fallback ?? match;
      });
      if (next !== entry) { resolved[key] = next; changed = true; }
    }
    if (!changed) break;
  }
  return resolved;
}

function nacosTargets(properties: Record<string, unknown>, environmentKey: string): Array<{ dataId: string; group: string; required: boolean }> {
  const targets: Array<{ dataId: string; group: string; required: boolean }> = [];
  for (const [key, entry] of Object.entries(properties)) {
    if (typeof entry !== "string") continue;
    if (/spring\.config\.import(?:\[\d+\])?$/.test(key)) {
      for (const item of entry.split(",")) {
        const configured = item.trim();
        const match = configured.match(/^(?:optional:)?nacos:([^?]+)(?:\?(.*))?$/);
        if (!match) continue;
        const query = new URLSearchParams(match[2] ?? "");
        targets.push({ dataId: match[1]!, group: query.get("group") ?? "DEFAULT_GROUP", required: !configured.startsWith("optional:") });
      }
    }
    if (/spring\.cloud\.nacos\.config\.(?:shared|extension)-configs\[\d+\]\.data-id$/.test(key)) {
      const prefix = key.slice(0, key.lastIndexOf(".data-id"));
      targets.push({ dataId: entry, group: value(properties, `${prefix}.group`) ?? "DEFAULT_GROUP", required: true });
    }
  }
  const application = value(properties, "spring.cloud.nacos.config.prefix", "spring.cloud.nacos.config.name", "spring.application.name");
  if (application) {
    const profile = value(properties, "spring.profiles.active") ?? environmentKey;
    const extension = value(properties, "spring.cloud.nacos.config.file-extension") ?? "yaml";
    const group = value(properties, "spring.cloud.nacos.config.group") ?? "DEFAULT_GROUP";
    targets.push({ dataId: `${application}.${extension}`, group, required: true });
    if (profile) targets.push({ dataId: `${application}-${profile}.${extension}`, group, required: false });
  }
  const unique = [...new Map(targets.map((target) => [`${target.dataId}\0${target.group}`, target])).values()];
  if (unique.length > MAX_NACOS_TARGETS) throw new Error("too_many_nacos_configuration_targets");
  if (unique.some((target) => !/^[a-zA-Z0-9._-]{1,255}$/.test(target.dataId) || !/^[a-zA-Z0-9._-]{1,255}$/.test(target.group))) throw new Error("invalid_nacos_configuration_target");
  return unique;
}

function nacosOrigin(value: string): string {
  const server = new URL(value.includes("://") ? value : `http://${value}`);
  if ((server.protocol !== "http:" && server.protocol !== "https:") || !server.hostname || server.username || server.password || server.search || server.hash || (server.pathname !== "/" && server.pathname !== "")) throw new Error("invalid_nacos_server");
  const port = server.port || (server.protocol === "https:" ? "443" : "8848");
  return `${server.protocol}//${server.hostname.toLowerCase()}:${port}`;
}

async function nacosContent(pi: ExtensionAPI, properties: Record<string, unknown>, target: { dataId: string; group: string }, allowedServers: string[], signal?: AbortSignal): Promise<string | null> {
  const configuredServer = value(properties, "spring.cloud.nacos.config.server-addr", "spring.cloud.nacos.server-addr", "nacos.server-addr");
  if (!configuredServer || configuredServer.includes("${")) throw new Error("nacos_server_not_resolved");
  const origin = nacosOrigin(configuredServer);
  const allowedOrigins = allowedServers.map(nacosOrigin);
  if (!allowedOrigins.includes(origin)) throw new Error("nacos_server_not_allowed");
  const server = new URL(origin);
  const profileRoot = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-nacos-"));
  try {
    const profile = {
      host: server.hostname,
      port: Number(server.port || (server.protocol === "https:" ? 443 : 8848)),
      scheme: server.protocol.slice(0, -1),
      authType: value(properties, "spring.cloud.nacos.username", "spring.cloud.nacos.config.username") ? "nacos" : "none",
      username: value(properties, "spring.cloud.nacos.username", "spring.cloud.nacos.config.username") ?? "",
      password: value(properties, "spring.cloud.nacos.password", "spring.cloud.nacos.config.password") ?? "",
      accessKey: "",
      secretKey: "",
      securityToken: "",
      token: "",
      namespace: value(properties, "spring.cloud.nacos.config.namespace", "spring.cloud.nacos.namespace") ?? "",
    };
    const profileFile = path.join(profileRoot, "issue.conf");
    const fallbackProfileFile = path.join(profileRoot, "issue.json");
    await Promise.all([
      writeFile(profileFile, YAML.stringify(profile), { mode: 0o600 }),
      writeFile(fallbackProfileFile, JSON.stringify(profile), { mode: 0o600 }),
    ]);
    const image = process.env.PI_NACOS_CLI_IMAGE ?? "docker.io/library/node:26.5.1-bookworm-slim";
    const container = ["run", "--rm", "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--read-only", "--tmpfs", "/tmp:size=64m,mode=1777"];
    const explicitConnection = ["--host", profile.host, "--port", String(profile.port), "--scheme", profile.scheme, "--auth-type", profile.authType, ...(profile.namespace ? ["--namespace", profile.namespace] : [])];
    const execution = await pi.exec("podman", [...container, "--volume", "nacos-cli-data:/opt/nacos-cli:ro", "--volume", `${profileRoot}:/home/node/.nacos-cli:ro,z`, "--env", "HOME=/home/node", image, "node", "/opt/nacos-cli/node_modules/@nacos-group/cli/bin/cli.js", "--profile", "issue", ...explicitConnection, "config-get", target.dataId, target.group], { timeout: 20_000, ...(signal ? { signal } : {}) });
    if (execution.code === 0) {
      const content = execution.stdout.replace(/^Fetching config:.*?\r?\n\r?\n═+\r?\nData ID:.*?\r?\nGroup:.*?\r?\n═+\r?\n/s, "");
      if (Buffer.byteLength(content, "utf8") > 2 * 1024 * 1024) throw new Error("nacos_configuration_read_failed");
      return content;
    }
    if (!/404 Not Found|resource not found/i.test(`${execution.stdout}\n${execution.stderr}`)) throw new Error("nacos_configuration_read_failed");

    const adapter = fileURLToPath(new URL("../../infra/nacos-config-get.mjs", import.meta.url));
    const fallback = await pi.exec("podman", [...container, "--volume", `${profileRoot}:/profile:ro,z`, "--volume", `${adapter}:/opt/issue-pilot/nacos-config-get.mjs:ro,z`, image, "node", "/opt/issue-pilot/nacos-config-get.mjs", "/profile/issue.json", target.dataId, target.group], { timeout: 20_000, ...(signal ? { signal } : {}) });
    if (fallback.code !== 0) {
      if (/nacos_configuration_read_failed:404|404 Not Found|resource not found/i.test(`${fallback.stdout}\n${fallback.stderr}`)) return null;
      throw new Error("nacos_configuration_read_failed");
    }
    if (Buffer.byteLength(fallback.stdout, "utf8") > 2 * 1024 * 1024) throw new Error("nacos_configuration_read_failed");
    return fallback.stdout;
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
  }
}

export async function resolveConfiguration(pi: ExtensionAPI, service: ServiceCapability, signal?: AbortSignal, secrets: Record<string, string> = {}, allowedNacosServers: string[] = []): Promise<ResolvedConfiguration> {
  const files = await frozenFiles(service);
  let properties: Record<string, unknown> = {};
  const sources: string[] = [];
  const missingSources: string[] = [];
  for (const file of files) {
    properties = { ...properties, ...parse(file.file, file.content) };
    sources.push(`repository:${file.file}`);
  }
  properties = resolvePlaceholders(properties, secrets);
  const server = value(properties, "spring.cloud.nacos.config.server-addr", "spring.cloud.nacos.server-addr", "nacos.server-addr");
  if (server) {
    for (const target of nacosTargets(properties, service.environmentKey)) {
      const source = `nacos:${target.dataId}/${target.group}`;
      const content = await nacosContent(pi, properties, target, allowedNacosServers, signal);
      if (content === null) {
        if (target.required) missingSources.push(source);
        continue;
      }
      properties = resolvePlaceholders({ ...properties, ...parse(target.dataId, content) }, secrets);
      sources.push(source);
    }
  }
  return { properties, sources, missingSources };
}

export function sanitizedConfiguration(configuration: ResolvedConfiguration): ResolvedConfiguration {
  const properties = Object.fromEntries(Object.entries(configuration.properties).map(([key, entry]) => {
    if (sensitive(key)) return [key, "[REDACTED]"];
    if (typeof entry === "string") return [key, redact(entry)];
    return [key, entry];
  }));
  return { properties, sources: configuration.sources, missingSources: configuration.missingSources };
}

export function datasourceUrl(configuration: ResolvedConfiguration): string {
  const url = value(configuration.properties, "spring.datasource.url", "spring.datasource.jdbc-url", "spring.datasource.hikari.jdbc-url");
  if (!url || url.includes("${")) throw new Error("datasource_url_not_resolved");
  const normalized = url.replace(/^jdbc:/, "");
  const parsed = new URL(normalized);
  if (parsed.protocol !== "mysql:" && parsed.protocol !== "mariadb:") throw new Error("unsupported_datasource_protocol");
  const username = value(configuration.properties, "spring.datasource.username", "spring.datasource.hikari.username");
  const password = value(configuration.properties, "spring.datasource.password", "spring.datasource.hikari.password");
  if (!parsed.username && username && !username.includes("${")) parsed.username = username;
  if (!parsed.password && password && !password.includes("${")) parsed.password = password;
  if (!parsed.username || !parsed.pathname.replace(/^\//, "")) throw new Error("datasource_credentials_not_resolved");
  return parsed.toString();
}
