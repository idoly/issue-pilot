"use strict";

const fs = require("node:fs");
const { chromium } = require("/tool/node_modules/playwright-core");

const [requestFile, credentialsFile] = process.argv.slice(2);
if (!requestFile || !credentialsFile) process.exit(2);

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function isAllowedUrl(value, baseUrl) {
  const url = new URL(value, baseUrl);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  return url.origin === new URL(baseUrl).origin;
}

async function run() {
  const request = readJsonFile(requestFile);
  const credentials = readJsonFile(credentialsFile);
  const baseUrl = new URL(request.baseUrl);
  if ((baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error("invalid_base_url");
  if (!Number.isSafeInteger(request.maxActions) || request.maxActions < 1) throw new Error("invalid_action_limit");
  if (!Number.isSafeInteger(request.actionTimeoutMs) || request.actionTimeoutMs < 1) throw new Error("invalid_action_timeout");
  if (!Number.isSafeInteger(request.navigationTimeoutMs) || request.navigationTimeoutMs < 1) throw new Error("invalid_navigation_timeout");
  if (!request.viewport || !Number.isSafeInteger(request.viewport.width) || request.viewport.width < 1 || !Number.isSafeInteger(request.viewport.height) || request.viewport.height < 1) throw new Error("invalid_viewport");
  if (!Array.isArray(request.actions) || request.actions.length < 1 || request.actions.length > request.maxActions) throw new Error("invalid_actions");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      acceptDownloads: false,
      viewport: request.viewport,
      serviceWorkers: "block",
    });
    await context.route("**/*", async (route) => {
      if (isAllowedUrl(route.request().url(), baseUrl.href)) await route.continue();
      else await route.abort("blockedbyclient");
    });
    if (typeof context.routeWebSocket === "function") {
      await context.routeWebSocket("**/*", (socket) => {
        if (!isAllowedUrl(socket.url(), baseUrl.href)) socket.close({ code: 1008, reason: "cross_origin_blocked" });
        else socket.connectToServer();
      });
    }
    const page = await context.newPage();
    context.on("page", (candidate) => { if (candidate !== page) void candidate.close(); });
    page.on("dialog", (dialog) => { void dialog.dismiss(); });
    page.on("download", (download) => { void download.cancel(); });
    page.setDefaultTimeout(request.actionTimeoutMs);
    page.setDefaultNavigationTimeout(request.navigationTimeoutMs);
    await page.goto(baseUrl.href, { waitUntil: "domcontentloaded" });

    for (const action of request.actions) {
      switch (action.type) {
        case "goto": {
          if (typeof action.path !== "string" || !action.path.startsWith("/") || action.path.startsWith("//")) throw new Error("invalid_path");
          const target = new URL(action.path, baseUrl.href);
          if (target.origin !== baseUrl.origin) throw new Error("cross_origin_blocked");
          await page.goto(target.href, { waitUntil: "domcontentloaded" });
          break;
        }
        case "login":
          if (typeof credentials.username !== "string" || typeof credentials.password !== "string") throw new Error("credentials_not_configured");
          await page.locator(action.usernameSelector).fill(credentials.username);
          await page.locator(action.passwordSelector).fill(credentials.password);
          await Promise.all([
            page.waitForLoadState("domcontentloaded").catch(() => undefined),
            page.locator(action.submitSelector).click(),
          ]);
          break;
        case "click":
          await page.locator(action.selector).click();
          break;
        case "fill":
          await page.locator(action.selector).fill(action.value);
          break;
        case "select":
          await page.locator(action.selector).selectOption(action.value);
          break;
        case "wait_for":
          await page.locator(action.selector).waitFor({ state: "visible" });
          break;
        default:
          throw new Error("unsupported_action");
      }
      if (new URL(page.url()).origin !== baseUrl.origin) throw new Error("cross_origin_navigation");
    }

    const snapshot = await page.evaluate(() => {
      const controls = [...document.querySelectorAll("a,button,input,select,textarea,[role=button]")]
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute("type") || undefined,
          name: element.getAttribute("name") || undefined,
          id: element.id || undefined,
          role: element.getAttribute("role") || undefined,
          text: (element.getAttribute("aria-label") || element.textContent || element.getAttribute("placeholder") || "").trim(),
        }));
      return { title: document.title, text: document.body?.innerText || "", controls };
    });
    const output = { url: page.url(), ...snapshot };
    if (request.screenshot === true) output.screenshot = (await page.screenshot({ type: "png", fullPage: false })).toString("base64");
    process.stdout.write(JSON.stringify(output));
    await context.close();
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "browser_failed"}\n`);
  process.exit(1);
});
