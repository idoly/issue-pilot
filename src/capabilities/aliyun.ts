import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { ContainerRuntime } from "../container-runtime.ts";
import type { CommandExecutionOptions, CommandExecutionResult } from "./local-exec.ts";

export interface AliyunCliCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  region: string;
}

export interface AliyunCliRuntime {
  image: string;
  version: string;
  containerPids: number;
  containerMemory: string;
}

const containerHome = "/home/aliyun";

export async function runAliyunCli(
  containers: ContainerRuntime,
  profileRoot: string,
  args: string[],
  options: CommandExecutionOptions,
  runtime: AliyunCliRuntime = issuePilotConfig.runtime.aliyunCli,
): Promise<CommandExecutionResult> {
  const uid = process.getuid?.() ?? issuePilotConfig.runtime.containerUser.uid;
  const gid = process.getgid?.() ?? issuePilotConfig.runtime.containerUser.gid;
  return containers.run({
    image: runtime.image,
    command: args,
    label: "io.issue-pilot.component=pi-tool",
    pids: runtime.containerPids,
    memory: runtime.containerMemory,
    uid,
    gid,
    environment: { HOME: containerHome, ALIBABA_CLOUD_ORIGINAL_PRODUCT_HELP: "true" },
    mounts: [{ source: profileRoot, target: containerHome, access: "ro", relabel: "private" }],
    tmpfs: ["/tmp:rw,noexec,nosuid,nodev,size=16m"],
  }, options);
}

export async function withAliyunCliProfile<Result>(
  credentials: AliyunCliCredentials,
  operation: (profileRoot: string) => Promise<Result>,
): Promise<Result> {
  const profileRoot = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-aliyun-"));
  try {
    const aliyunRoot = path.join(profileRoot, ".aliyun");
    await mkdir(aliyunRoot, { mode: 0o700 });
    await writeFile(path.join(aliyunRoot, "config.json"), JSON.stringify({
      current: "issue-pilot",
      profiles: [{
        name: "issue-pilot",
        mode: "AK",
        region_id: credentials.region,
        output_format: "json",
        language: "en",
        site: "China",
        access_key_id: credentials.accessKeyId,
        access_key_secret: credentials.accessKeySecret,
      }],
    }), { mode: 0o600 });
    return await operation(profileRoot);
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
  }
}
