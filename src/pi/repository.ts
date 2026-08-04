import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { result } from "../evidence/output.ts";
import type { GrantedRepository } from "./policy.ts";

export async function repositoryStatus(pi: ExtensionAPI, repositories: GrantedRepository[], action: "status" | "diff", signal?: AbortSignal) {
  const outputs = [];
  for (const service of repositories) {
    const args = action === "status"
      ? ["-C", service.repositoryPath, "status", "--short", "--untracked-files=all"]
      : ["-C", service.repositoryPath, "diff", "--no-ext-diff", "--no-color"];
    const execution = await pi.exec("git", args, { timeout: 30_000, ...(signal ? { signal } : {}) });
    if (execution.code !== 0) throw new Error(`repository_${action}_failed`);
    outputs.push({ repository: path.basename(service.repositoryPath), output: execution.stdout });
  }
  return result({ action, repositories: outputs }, { serviceKey: repositories[0]!.serviceKey, action });
}
