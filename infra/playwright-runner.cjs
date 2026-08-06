"use strict";

const fs = require("node:fs");
const { chromium } = require("/tool/node_modules/playwright-core");

const [requestFile, credentialsFile] = process.argv.slice(2);
if (!requestFile || !credentialsFile) process.exit(2);

function parse(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function allowedUrl(value, baseUrl) {
  const url = new URL(value, baseUrl);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  return url.origin === new URL(baseUrl).origin;
}

async function main() {
  const request = parse(requestFile);
  const credentials = parse(credentialsFile);
  const baseUrl = new URL(request.baseUrl);
  if ((baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error("invalid_base_url");
  if (!Array.isArray(request.actions) || request.actions.length < 1 || request.actions.length > 20) throw new Error("invalid_actions");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      acceptDownloads: false,
      viewport: { width: 1280, height: 720 },
      serviceWorkers: "block",
    });
    await context.route("**/*", async (route) => {
      if (allowedUrl(route.request().url(), baseUrl.href)) await route.continue();
      else await route.abort("blockedbyclient");
    });
    if (typeof context.routeWebSocket === "function") {
      await context.routeWebSocket("**/*", (socket) => {
        if (!allowedUrl(socket.url(), baseUrl.href)) socket.close({ code: 1008, reason: "cross_origin_blocked" });
        else socket.connectToServer();
      });
    }
    const page = await context.newPage();
    context.on("page", (candidate) => { if (candidate !== page) void candidate.close(); });
    page.on("dialog", (dialog) => { void dialog.dismiss(); });
    page.on("download", (download) => { void download.cancel(); });
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(20_000);
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

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "browser_failed"}\n`);
  process.exit(1);
});
