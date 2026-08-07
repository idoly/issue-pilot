import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { IssuePolicy } from "../pi/policy.ts";
import type { CommandExecutor } from "./local-exec.ts";

const DEFAULT_IMAGE = "mcr.microsoft.com/playwright:v1.62.1-noble";

export type BrowserAction =
  | { type: "goto"; path: string }
  | { type: "login"; usernameSelector: string; passwordSelector: string; submitSelector: string }
  | { type: "click"; selector: string }
  | { type: "fill"; selector: string; value: string }
  | { type: "select"; selector: string; value: string }
  | { type: "wait_for"; selector: string };

function deploymentBrowser(value: Record<string, unknown>): { baseUrl: string; username: string | null; password: string | null } {
  const raw = value.playwright;
  if (!raw || typeof raw !== "object") throw new Error("browser_configuration_not_found");
  const browser = raw as Record<string, unknown>;
  if (typeof browser.baseUrl !== "string") throw new Error("browser_configuration_not_found");
  return {
    baseUrl: browser.baseUrl,
    username: typeof browser.username === "string" ? browser.username : null,
    password: typeof browser.password === "string" ? browser.password : null,
  };
}

function credentials(policy: IssuePolicy, config: Record<string, unknown>): { username: string | null; password: string | null } {
  const scope = policy.service.browser;
  if (!scope || !policy.service.capabilities.includes("playwright")) throw new Error("browser_scope_not_granted_for_service");
  const browser = deploymentBrowser(config);
  if (browser.baseUrl !== scope.baseUrl) throw new Error("browser_scope_changed");
  return { username: browser.username, password: browser.password };
}

function validateActions(actions: BrowserAction[]): void {
  if (!Array.isArray(actions) || actions.length < 1) throw new Error("invalid_browser_actions");
  for (const action of actions) {
    if (!action || typeof action !== "object") throw new Error("invalid_browser_action");
    if (action.type === "goto") {
      if (typeof action.path !== "string" || !action.path.startsWith("/") || action.path.startsWith("//") || action.path.length > 2048 || action.path.includes("\0")) throw new Error("invalid_browser_path");
      continue;
    }
    if (action.type === "login") {
      for (const selector of [action.usernameSelector, action.passwordSelector, action.submitSelector]) if (typeof selector !== "string" || !selector || selector.length > 500 || selector.includes("\0")) throw new Error("invalid_browser_selector");
      continue;
    }
    if (action.type === "click" || action.type === "wait_for") {
      if (typeof action.selector !== "string" || !action.selector || action.selector.length > 500 || action.selector.includes("\0")) throw new Error("invalid_browser_selector");
      continue;
    }
    if (action.type === "fill" || action.type === "select") {
      if (typeof action.selector !== "string" || !action.selector || action.selector.length > 500 || action.selector.includes("\0") || typeof action.value !== "string" || action.value.length > 10_000 || action.value.includes("\0")) throw new Error("invalid_browser_action");
      continue;
    }
    throw new Error("invalid_browser_action");
  }
}

export async function useBrowser(pi: CommandExecutor, policy: IssuePolicy, config: Record<string, unknown>, input: { actions: BrowserAction[]; screenshot?: boolean }, signal?: AbortSignal) {
  const scope = policy.service.browser;
  if (!scope) throw new Error("browser_scope_not_granted_for_service");
  validateActions(input.actions);
  const secret = credentials(policy, config);
  if (input.actions.some((action) => action.type === "login") && (!secret.username || !secret.password)) throw new Error("browser_credentials_not_configured");

  const stateRoot = process.env.ISSUE_PILOT_STATE_ROOT ?? path.dirname(path.dirname(policy.workspaceRoot));
  const toolCacheRoot = process.env.PI_TOOL_CACHE_ROOT ?? path.join(stateRoot, "tools");
  const toolCache = path.resolve(toolCacheRoot, "playwright");
  await access(path.join(toolCache, "node_modules", "playwright-core", "package.json"));
  const runner = fileURLToPath(new URL("../../infra/playwright-runner.cjs", import.meta.url));
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-browser-"));
  const inputDirectory = path.join(temporaryRoot, "input");
  const secretDirectory = path.join(temporaryRoot, "secrets");
  try {
    await Promise.all([mkdir(inputDirectory, { mode: 0o700 }), mkdir(secretDirectory, { mode: 0o700 })]);
    const requestFile = path.join(inputDirectory, "request.json");
    const credentialsFile = path.join(secretDirectory, "credentials.json");
    await Promise.all([
      writeFile(requestFile, JSON.stringify({ baseUrl: scope.baseUrl, actions: input.actions, screenshot: input.screenshot === true }), { mode: 0o600 }),
      writeFile(credentialsFile, JSON.stringify(secret), { mode: 0o600 }),
    ]);
    const args = [
      "run", "--rm", "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--network", "host",
      "--pids-limit", "256", "--memory", "1g", "--userns", "keep-id", "--user", `${uid}:${gid}`,
      "--volume", `${runner}:/runner/playwright-runner.cjs:ro,Z`,
      "--volume", `${inputDirectory}:/run/input:ro,Z`,
      "--volume", `${secretDirectory}:/run/secrets:ro,Z`,
      "--volume", `${toolCache}:/tool:ro,Z`,
      "--entrypoint", "node",
      process.env.PI_PLAYWRIGHT_IMAGE ?? DEFAULT_IMAGE,
      "/runner/playwright-runner.cjs", "/run/input/request.json", "/run/secrets/credentials.json",
    ];
    const execution = await pi.exec("podman", args, { timeout: 90_000, ...(signal ? { signal } : {}) });
    if (execution.code !== 0) throw new Error("browser_operation_failed");
    let output: Record<string, unknown>;
    try { output = JSON.parse(execution.stdout) as Record<string, unknown>; } catch { throw new Error("browser_invalid_response"); }
    const screenshot = typeof output.screenshot === "string" ? output.screenshot : undefined;
    delete output.screenshot;
    const content: [{ type: "text"; text: string }, ...Array<{ type: "image"; data: string; mimeType: string }>] = [
      { type: "text", text: JSON.stringify(output, null, 2) },
    ];
    const response = { content, details: { runtime: "container", baseUrl: scope.baseUrl, actionCount: input.actions.length } };
    if (screenshot) {
      const image = Buffer.from(screenshot, "base64");
      (response.content as Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>).push({ type: "image", data: image.toString("base64"), mimeType: "image/png" });
    }
    return response;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
