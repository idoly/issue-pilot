import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { result } from "../evidence/output.ts";
import type { ServiceCapability } from "./policy.ts";

export async function repositoryStatus(pi: ExtensionAPI, services: ServiceCapability[], action: "status" | "diff", signal?: AbortSignal) {
  if (!services.length) throw new Error("service_not_granted_for_issue");
  const repositories = [];
  for (const service of services) {
    const args = action === "status"
      ? ["-C", service.repositoryPath, "status", "--short", "--untracked-files=all"]
      : ["-C", service.repositoryPath, "diff", "--no-ext-diff", "--no-color"];
    const execution = await pi.exec("git", args, { timeout: 30_000, ...(signal ? { signal } : {}) });
    if (execution.code !== 0) throw new Error(`repository_${action}_failed`);
    repositories.push({ repository: path.basename(service.repositoryPath), output: execution.stdout });
  }
  return result({ action, repositories }, { serviceKey: services[0]!.serviceKey, action });
}
