import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { IssuePolicy } from "../pi/policy.ts";
import { capabilityResultText } from "./contracts.ts";
import type { CommandExecutor } from "./local-exec.ts";

const limits = issuePilotConfig.limits.capability;

type BrowserRuntime = Readonly<{
  version: string;
  image: string;
  playwrightCoreRoot: string;
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
  containerPids: number;
  containerMemory: string;
  viewport: Readonly<{ width: number; height: number }>;
}>;

export type BrowserAction =
  | { type: "goto"; path: string }
  | { type: "login"; usernameSelector: string; passwordSelector: string; submitSelector: string }
  | { type: "click"; selector: string }
  | { type: "fill"; selector: string; value: string }
  | { type: "select"; selector: string; value: string }
  | { type: "wait_for"; selector: string };

function deploymentBrowserConfiguration(deploymentConfig: Record<string, unknown>): { baseUrl: string; username: string | null; password: string | null } {
  const raw = deploymentConfig.playwright;
  if (!raw || typeof raw !== "object") throw new Error("browser_configuration_not_found");
  const playwright = raw as Record<string, unknown>;
  if (typeof playwright.baseUrl !== "string") throw new Error("browser_configuration_not_found");
  return {
    baseUrl: playwright.baseUrl,
    username: typeof playwright.username === "string" ? playwright.username : null,
    password: typeof playwright.password === "string" ? playwright.password : null,
  };
}

function browserCredentials(policy: IssuePolicy, deploymentConfig: Record<string, unknown>): { username: string | null; password: string | null } {
  const scope = policy.service.playwright;
  if (!scope || !policy.service.capabilities.includes("playwright")) throw new Error("browser_scope_not_granted_for_service");
  const browserConfig = deploymentBrowserConfiguration(deploymentConfig);
  if (browserConfig.baseUrl !== scope.baseUrl) throw new Error("browser_scope_changed");
  return { username: browserConfig.username, password: browserConfig.password };
}

function validateBrowserActions(actions: BrowserAction[]): void {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > limits.browser.actions) throw new Error("invalid_browser_actions");
  for (const action of actions) {
    if (!action || typeof action !== "object") throw new Error("invalid_browser_action");
    if (action.type === "goto") {
      if (typeof action.path !== "string" || !action.path.startsWith("/") || action.path.startsWith("//") || action.path.length > limits.browser.pathChars || action.path.includes("\0")) throw new Error("invalid_browser_path");
      continue;
    }
    if (action.type === "login") {
      for (const selector of [action.usernameSelector, action.passwordSelector, action.submitSelector]) if (typeof selector !== "string" || !selector || selector.length > limits.browser.selectorChars || selector.includes("\0")) throw new Error("invalid_browser_selector");
      continue;
    }
    if (action.type === "click" || action.type === "wait_for") {
      if (typeof action.selector !== "string" || !action.selector || action.selector.length > limits.browser.selectorChars || action.selector.includes("\0")) throw new Error("invalid_browser_selector");
      continue;
    }
    if (action.type === "fill" || action.type === "select") {
      if (typeof action.selector !== "string" || !action.selector || action.selector.length > limits.browser.selectorChars || action.selector.includes("\0") || typeof action.value !== "string" || action.value.length > limits.browser.valueChars || action.value.includes("\0")) throw new Error("invalid_browser_action");
      continue;
    }
    throw new Error("invalid_browser_action");
  }
}

export async function runBrowserActions(executor: CommandExecutor, policy: IssuePolicy, deploymentConfig: Record<string, unknown>, input: { actions: BrowserAction[]; screenshot?: boolean }, signal?: AbortSignal, runtime: BrowserRuntime = issuePilotConfig.runtime.playwright) {
  const scope = policy.service.playwright;
  if (!scope) throw new Error("browser_scope_not_granted_for_service");
  validateBrowserActions(input.actions);
  const credentials = browserCredentials(policy, deploymentConfig);
  if (input.actions.some((action) => action.type === "login") && (!credentials.username || !credentials.password)) throw new Error("browser_credentials_not_configured");

  const playwrightCoreRoot = path.resolve(runtime.playwrightCoreRoot);
  let installedVersion = "";
  try {
    installedVersion = JSON.parse(await readFile(path.join(playwrightCoreRoot, "package.json"), "utf8")).version;
  } catch {
    throw new Error("playwright_core_not_installed");
  }
  if (installedVersion !== runtime.version) throw new Error("playwright_core_version_mismatch");
  const runner = fileURLToPath(new URL("../../infra/playwright-runner.cjs", import.meta.url));
  const uid = process.getuid?.() ?? issuePilotConfig.runtime.containerUser.uid;
  const gid = process.getgid?.() ?? issuePilotConfig.runtime.containerUser.gid;
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-browser-"));
  const inputDirectory = path.join(temporaryRoot, "input");
  const secretDirectory = path.join(temporaryRoot, "secrets");
  try {
    await Promise.all([mkdir(inputDirectory, { mode: 0o700 }), mkdir(secretDirectory, { mode: 0o700 })]);
    const requestFile = path.join(inputDirectory, "request.json");
    const credentialsFile = path.join(secretDirectory, "credentials.json");
    await Promise.all([
      writeFile(requestFile, JSON.stringify({
        baseUrl: scope.baseUrl,
        actions: input.actions,
        screenshot: input.screenshot === true,
        maxActions: limits.browser.actions,
        actionTimeoutMs: runtime.actionTimeoutMs,
        navigationTimeoutMs: runtime.navigationTimeoutMs,
        viewport: runtime.viewport,
      }), { mode: 0o600 }),
      writeFile(credentialsFile, JSON.stringify(credentials), { mode: 0o600 }),
    ]);
    const args = [
      "run", "--rm", "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--network", "host",
      "--pids-limit", String(runtime.containerPids), "--memory", runtime.containerMemory, "--userns", "keep-id", "--user", `${uid}:${gid}`,
      "--volume", `${runner}:/runner/playwright-runner.cjs:ro,Z`,
      "--volume", `${inputDirectory}:/run/input:ro,Z`,
      "--volume", `${secretDirectory}:/run/secrets:ro,Z`,
      "--volume", `${playwrightCoreRoot}:/tool/node_modules/playwright-core:ro,Z`,
      "--entrypoint", "node",
      runtime.image,
      "/runner/playwright-runner.cjs", "/run/input/request.json", "/run/secrets/credentials.json",
    ];
    const execution = await executor.execute("podman", args, { timeout: limits.browser.executionMs, ...(signal ? { signal } : {}) });
    if (execution.code !== 0) throw new Error("browser_operation_failed");
    let output: Record<string, unknown>;
    try { output = JSON.parse(execution.stdout) as Record<string, unknown>; } catch { throw new Error("browser_invalid_response"); }
    const screenshot = typeof output.screenshot === "string" ? output.screenshot : undefined;
    delete output.screenshot;
    const text = capabilityResultText(output);
    const image = screenshot ? Buffer.from(screenshot, "base64") : undefined;
    if (image && image.length + Buffer.byteLength(text) > limits.resultBytes) throw new Error("capability_result_too_large");
    const content: [{ type: "text"; text: string }, ...Array<{ type: "image"; data: string; mimeType: string }>] = [{ type: "text", text }];
    const response = { content, details: { runtime: "container", baseUrl: scope.baseUrl, actionCount: input.actions.length } };
    if (image) {
      (response.content as Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>).push({ type: "image", data: image.toString("base64"), mimeType: "image/png" });
    }
    return response;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
