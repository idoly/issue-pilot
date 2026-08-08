import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isNacosTarget, MAX_NACOS_DATA_IDS } from "./contracts.ts";
import type { CommandExecutor } from "./local-exec.ts";

export interface NacosConnection {
  serverUrl: string;
  namespace: string;
  group: string;
  username: string;
  password: string;
  dataIds: string[];
}

function nacosOrigin(value: string): string {
  const server = new URL(value.includes("://") ? value : `http://${value}`);
  if ((server.protocol !== "http:" && server.protocol !== "https:") || !server.hostname || server.username || server.password || server.search || server.hash || (server.pathname !== "/" && server.pathname !== "")) throw new Error("invalid_nacos_server");
  const port = server.port || (server.protocol === "https:" ? "443" : "8848");
  return `${server.protocol}//${server.hostname.toLowerCase()}:${port}`;
}

async function nacosContent(pi: CommandExecutor, dataId: string, connection: NacosConnection, signal?: AbortSignal): Promise<string | null> {
  const server = new URL(nacosOrigin(connection.serverUrl));
  const profileRoot = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-nacos-"));
  try {
    const profile = {
      host: server.hostname,
      port: Number(server.port || (server.protocol === "https:" ? 443 : 8848)),
      scheme: server.protocol.slice(0, -1),
      username: connection.username,
      password: connection.password,
      namespace: connection.namespace,
    };
    const profileFile = path.join(profileRoot, "connection.json");
    await writeFile(profileFile, JSON.stringify(profile), { mode: 0o600 });
    const runner = fileURLToPath(new URL("../../infra/nacos-read.mjs", import.meta.url));
    const image = process.env.PI_NACOS_IMAGE ?? "docker.io/library/node:26.5.1-bookworm-slim";
    const container = ["run", "--rm", "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--read-only", "--pids-limit", "64", "--memory", "128m", "--tmpfs", "/tmp:size=32m,mode=1777"];
    const execution = await pi.exec("podman", [...container, "--volume", `${profileRoot}:/run/secret:ro,z`, "--volume", `${runner}:/run/nacos-read.mjs:ro,z`, image, "node", "/run/nacos-read.mjs", "/run/secret/connection.json", dataId, connection.group], { timeout: 20_000, ...(signal ? { signal } : {}) });
    if (execution.code !== 0) {
      if (/nacos_configuration_read_failed:404/i.test(`${execution.stdout}\n${execution.stderr}`)) return null;
      throw new Error("nacos_configuration_read_failed");
    }
    return execution.stdout;
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
  }
}

export async function readNacosConfigurations(pi: CommandExecutor, connection: NacosConnection, signal?: AbortSignal): Promise<Array<{ dataId: string; group: string; content: string | null }>> {
  if (!isNacosTarget(connection.group) || !Array.isArray(connection.dataIds) || !connection.dataIds.length || connection.dataIds.length > MAX_NACOS_DATA_IDS || connection.dataIds.some((dataId) => !isNacosTarget(dataId)) || new Set(connection.dataIds).size !== connection.dataIds.length) throw new Error("invalid_nacos_configuration_target");
  const configurations = [];
  for (const dataId of connection.dataIds) configurations.push({ dataId, group: connection.group, content: await nacosContent(pi, dataId, connection, signal) });
  return configurations;
}
