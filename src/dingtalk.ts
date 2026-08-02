import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Issue } from "./store.ts";

const execFileAsync = promisify(execFile);

export interface DingTalkNotifierOptions {
  executable?: string;
  group?: string;
  openDingTalkId?: string;
  profile?: string;
  issueBaseUrl?: string;
  dryRun?: boolean;
}

export interface NotificationResult {
  idempotencyKey: string;
  output: unknown;
}

function uuidFor(value: string): string {
  const bytes = Buffer.from(createHash("sha256").update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function formatCompletionMessage(issue: Issue, issueBaseUrl?: string): string {
  const branches = issue.repositories
    .map((repository) => repository.workingBranch)
    .filter((branch): branch is string => Boolean(branch));
  const tests = issue.testRuns.map((run) => `${run.scope}: ${run.status}`).join("，") || "无测试记录";
  const classification = issue.diagnosis.classification === "bug" ? "确认缺陷" : issue.diagnosis.classification;
  const lines = [
    `工单 ${issue.id} 已处理完成`,
    `标题：${issue.title}`,
    `结论：${classification}`,
    `状态：${issue.status}`,
    `测试：${tests}`,
  ];
  if (branches.length) lines.push(`分支：${branches.join("，")}`);
  if (issueBaseUrl) lines.push(`详情：${issueBaseUrl.replace(/\/$/, "")}/${encodeURIComponent(issue.id)}`);
  return lines.join("\n");
}

export class DingTalkNotifier {
  private readonly options: DingTalkNotifierOptions;

  constructor(options: DingTalkNotifierOptions) {
    this.options = options;
    if (!options.group && !options.openDingTalkId) {
      throw new Error("DingTalk notification requires a group or openDingTalkId");
    }
    if (options.group && options.openDingTalkId) {
      throw new Error("DingTalk notification target must be either a group or openDingTalkId");
    }
  }

  async notifyCompleted(issue: Issue): Promise<NotificationResult> {
    const idempotencyKey = uuidFor(`${issue.id}:${issue.updatedAt}:completed`);
    const args = ["chat", "message", "send"];
    if (this.options.group) args.push("--group", this.options.group);
    else args.push("--open-dingtalk-id", this.options.openDingTalkId!);
    args.push(
      "--title", `工单处理完成 ${issue.id}`,
      "--text", formatCompletionMessage(issue, this.options.issueBaseUrl),
      "--uuid", idempotencyKey,
      "--format", "json",
      "--yes",
    );
    if (this.options.profile) args.push("--profile", this.options.profile);
    if (this.options.dryRun) args.push("--dry-run");

    const { stdout } = await execFileAsync(this.options.executable ?? "dws", args, {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    let output: unknown = stdout.trim();
    try {
      output = JSON.parse(stdout);
    } catch {
      // Keep non-JSON output for diagnostics without exposing process environment.
    }
    return { idempotencyKey, output };
  }
}

export function dingTalkNotifierFromEnvironment(): DingTalkNotifier | undefined {
  const group = process.env.DINGTALK_NOTIFY_GROUP;
  const openDingTalkId = process.env.DINGTALK_NOTIFY_OPEN_ID;
  if (!group && !openDingTalkId) return undefined;
  const options: DingTalkNotifierOptions = {
    executable: process.env.DINGTALK_CLI ?? "dws",
    ...(group && { group }),
    ...(openDingTalkId && { openDingTalkId }),
    ...(process.env.DINGTALK_PROFILE && { profile: process.env.DINGTALK_PROFILE }),
    ...(process.env.ISSUE_AGENT_BASE_URL && { issueBaseUrl: process.env.ISSUE_AGENT_BASE_URL }),
    dryRun: process.env.DINGTALK_DRY_RUN === "1",
  };
  return new DingTalkNotifier(options);
}
