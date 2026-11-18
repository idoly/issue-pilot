import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";

import { sharedConfig } from "../../../../issue-pilot.config";
import type { IssueDetail } from "../data/client";
import { AgentPanel } from "./AgentPanel";
import { AgentDraftStore } from "./agent-drafts";

const issue: IssueDetail = {
  id: "ISSUE-20260810-001",
  title: "Fixture",
  description: "",
  editVersion: "a".repeat(64),
  priority: "p1",
  type: "defect_fix",
  status: "open",
  assignee: null,
  assigneeSubject: null,
  reporterSubject: "reporter",
  ccSubjects: [],
  service: { key: "service", name: "Service" },
  environmentKey: "dev",
  revision: "revision-1",
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
  workspaceStatus: "ready",
  agentRunning: false,
  resolvedAt: null,
  repositories: [],
  attachments: [],
  collaboratingServices: [],
  relatedIssues: [],
  scopeTransitions: [],
  ccRecipients: [],
  workingDirectory: "/fixture/workspaces/issue",
  workspace: { status: "ready", sourceAvailable: false, runtimeReady: true, lastError: null, retryable: false },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const paste = (files: File[]) => {
  render(() => AgentPanel({ issue, drafts: new AgentDraftStore(), onRefresh: async () => issue }));
  fireEvent.paste(screen.getByLabelText("发送给 Agent"), { clipboardData: { files, getData: () => "" } });
};

it("reports an unsupported pasted image type separately from size limits", async () => {
  const createObjectUrl = vi.spyOn(URL, "createObjectURL");
  paste([new File([new Uint8Array([0x42, 0x4d])], "clipboard.bmp", { type: "image/bmp" })]);
  expect((await screen.findByRole("alert")).textContent).toContain("只能粘贴 PNG、JPEG、GIF 或 WebP 图片");
  expect(createObjectUrl).not.toHaveBeenCalled();
});

it("states the actual image limits without protocol jargon", async () => {
  const createObjectUrl = vi.spyOn(URL, "createObjectURL");
  const oversized = new File([new Uint8Array(1)], "large.png", { type: "image/png" });
  Object.defineProperty(oversized, "size", { value: sharedConfig.limits.agentImage.fileBytes + 1 });
  paste([oversized]);
  const text = (await screen.findByRole("alert")).textContent ?? "";
  expect(text).toContain(`最多 ${sharedConfig.limits.agentImage.files} 张`);
  expect(text).toContain(`${sharedConfig.limits.agentImage.fileBytes / 1024 / 1024} MB`);
  expect(text).not.toContain("multipart");
  expect(createObjectUrl).not.toHaveBeenCalled();
});
