import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ToolRuntime } from "../tool-runtime.ts";
import type { CommandExecutionResult } from "./local-exec.ts";

export interface AliyunCliCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  region: string;
}

export async function runAliyunCli(
  tools: ToolRuntime,
  profileRoot: string,
  args: string[],
  options: { timeout?: number; signal?: AbortSignal; maxOutputBytes?: number },
): Promise<CommandExecutionResult> {
  return tools.run({
    command: ["aliyun", ...args],
    environment: { HOME: profileRoot, ALIBABA_CLOUD_ORIGINAL_PRODUCT_HELP: "true" },
    ...options,
  });
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
