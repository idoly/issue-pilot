import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { AgentEventBus } from "../../src/agent/events.ts";
import { buildApi } from "../../src/http/api.ts";
import { openDatabase } from "../../src/db/client.ts";
import { issueRepositories, issueWorkspaces, issues } from "../../src/db/schema.ts";
import { repositoryStorePath } from "../../src/workspace/git.ts";
import { issueRoot } from "../../src/workspace/state.ts";
import { prepareIssueRuntime } from "../../src/workspace/runtime.ts";
import { createService, createIssue, modelCatalog, TestAgentController } from "../http/fixture.ts";

// Playwright is optional verification tooling; install it outside the application checkout.
const { chromium } = await import(process.env.ISSUE_PILOT_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.ISSUE_PILOT_PLAYWRIGHT_MODULE).href : "playwright");
const exec = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-browser-"));
let app, browser, page;
try {
  const engine = new TestAgentController();
  const events = new AgentEventBus();
  const databaseFile = path.join(root, "issues.db");
  app = await buildApi({ stateRoot: root, databaseFile, engine, events, modelCatalog, logger: false, webRoot: path.resolve("src/web/dist") });
  await createService(app, "browser", ["dev"]);
  const created = await createIssue(app, "browser", "dev", "Browser acceptance fixture");
  const database = openDatabase(databaseFile);
  let issue;
  try {
    [issue] = await database.db.select().from(issues).where(eq(issues.key, created.id));
  } finally {
    database.close();
  }
  engine.running.clear();
  const url = "https://example.test/browser.git";
  const source = path.join(root, "seed");
  await exec("git", ["init", "-b", "main", source]);
  await writeFile(path.join(source, "sample.json"), '{\r\n  "message": "original 订单",\r\n  "enabled": true\r\n}\r\n');
  await writeFile(path.join(source, "notes.ts"), "export const ready = true;\n");
  await exec("git", ["-C", source, "add", "."]);
  await exec("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Initial fixture"]);
  const commit = (await exec("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  const store = repositoryStorePath(root, url);
  await mkdir(path.dirname(store), { recursive: true });
  await exec("git", ["clone", "--bare", source, store]);
  const checkout = path.join(issueRoot(root, issue.key), "application");
  const branch = "browser-fixture";
  await exec("git", ["--git-dir", store, "worktree", "add", "-b", branch, checkout, "main"]);
  const seedDatabase = openDatabase(databaseFile);
  try {
    await seedDatabase.db
      .insert(issueRepositories)
      .values({ issueId: issue.id, url, baseBranch: "main", workingBranch: branch, localPath: checkout, workspaceName: "application", commitBefore: commit });
    await seedDatabase.db.update(issueWorkspaces).set({ status: "ready", runtimeReady: true }).where(eq(issueWorkspaces.issueId, issue.id));
  } finally {
    seedDatabase.close();
  }
  await prepareIssueRuntime(root, issue.key, [{ name: "application", repositoryPath: checkout }], "write");
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  assert.equal((await fetch(`${origin}/health`)).status, 200);
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1680, height: 1050 }, permissions: ["clipboard-read", "clipboard-write"] });
  page.setDefaultTimeout(15000);
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(message.text());
  });
  page.on("requestfailed", (request) => {
    if (!request.failure()?.errorText.includes("ERR_ABORTED")) failures.push(`${request.url()}: ${request.failure()?.errorText}`);
  });
  await page.goto(`${origin}/?issue=${issue.key}`);
  await page.getByRole("button", { name: "浏览工单代码", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => performance.getEntriesByType("resource").some((entry) => /\/(monaco-|editor\.|CodeBrowser-)/.test(entry.name))), false);
  await page.getByRole("button", { name: "浏览工单代码", exact: true }).click();
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("button", { name: "sample.json", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "代码内容 sample.json", exact: true });
  await editor.waitFor();
  assert.ok(await page.locator(".monaco-editor .view-lines").innerText());
  await page.waitForFunction(() => new Set(Array.from(document.querySelectorAll(".view-lines span[class^=mtk]"), (span) => getComputedStyle(span).color)).size >= 3);
  await page.waitForFunction(() => Array.from(document.querySelectorAll(".editor-file-icon")).every((image) => image.complete && image.naturalWidth > 0));
  await editor.press("Control+Home");
  await editor.press("Control+f");
  await page.getByRole("textbox", { name: "Find", exact: true }).fill("original");
  await page.keyboard.press("Escape");
  await editor.press("Control+Home");
  await editor.press("Control+a");
  await page.evaluate((value) => navigator.clipboard.writeText(value), '{\n  "message": "edited 订单",\n  "enabled": false\n}\n');
  await editor.press("Control+v");
  await editor.press("Control+s");
  await page.getByLabel("文件保存状态", { exact: true }).filter({ hasText: "已保存" }).waitFor();
  assert.equal(await readFile(path.join(checkout, "sample.json"), "utf8"), '{\r\n  "message": "edited 订单",\r\n  "enabled": false\r\n}\r\n');
  await editor.press("Control+z");
  await editor.press("Control+s");
  await page.getByLabel("文件保存状态", { exact: true }).filter({ hasText: "已保存" }).waitFor();
  assert.match(await readFile(path.join(checkout, "sample.json"), "utf8"), /original 订单/);
  await editor.press("Control+y");
  await editor.press("Control+s");
  await page.getByLabel("文件保存状态", { exact: true }).filter({ hasText: "已保存" }).waitFor();
  assert.match(await readFile(path.join(checkout, "sample.json"), "utf8"), /edited 订单/);
  await page.getByRole("button", { name: "变更", exact: true }).click();
  await page.getByRole("button", { name: "查看差异 sample.json", exact: true }).click();
  await page.getByRole("region", { name: "代码差异", exact: true }).waitFor();
  await page.locator(".source-diff-summary .added").filter({ hasText: "+2" }).waitFor();
  await page.locator(".source-editor").hover();
  await page.getByRole("button", { name: "并排", exact: true }).click();
  await page.getByRole("button", { name: "行内", exact: true }).click();
  await page.getByRole("button", { name: "关闭差异", exact: true }).click();
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("button", { name: "notes.ts", exact: true }).click();
  await page.getByRole("textbox", { name: "代码内容 notes.ts", exact: true }).waitFor();
  await page.getByRole("button", { name: "sample.json", exact: true }).click();
  await editor.waitFor();
  assert.equal(failures.length, 0, failures.join("\n"));
  const external = '{"external": true}\r\n';
  await writeFile(path.join(checkout, "sample.json"), external);
  await editor.press("Control+End");
  await page.keyboard.insertText("// retained draft");
  const conflict = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith("/source/file") && response.status() === 409);
  await editor.press("Control+s");
  await conflict;
  await page.getByLabel("文件保存状态", { exact: true }).filter({ hasText: "草稿已保留" }).waitFor();
  assert.equal(await readFile(path.join(checkout, "sample.json"), "utf8"), external);
  assert.match(await page.locator(".monaco-editor .view-lines").innerText(), /retained.*draft/);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("radio", { name: "首页", exact: true }).click();
  await editor.waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".source-editor").hover();
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await page.getByLabel("文件保存状态", { exact: true }).filter({ hasText: "已保存" }).waitFor();
  await page.waitForFunction(() => document.querySelector(".monaco-editor .view-lines")?.textContent.includes("external"));
  await page.getByRole("button", { name: "关闭代码浏览器", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "发送给 Agent", exact: true });
  await draft.fill("unsent browser draft");
  await page.getByRole("radio", { name: "首页", exact: true }).click();
  await page.getByRole("radio", { name: "工单", exact: true }).click();
  await draft.waitFor();
  assert.equal(await draft.inputValue(), "unsent browser draft");
  await page.getByText("还没有对话", { exact: true }).waitFor();
  const publish = (event) => events.publish({ id: randomUUID(), issueId: issue.id, createdAt: new Date().toISOString(), event });
  publish({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Browser reasoning evidence" },
        {
          type: "text",
          text: 'Browser SSE evidence\n\nSecond paragraph 订单\n\n```text\nvalue\n```~\n<img src="x">\n```\n\n[unfinished](/file\\) and [valid](https://example.test/file\\))',
        },
      ],
      api: "openai-completions",
      provider: "fixture",
      model: "fixture",
      timestamp: Date.now(),
      stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  });
  await page.getByText("Second paragraph 订单", { exact: true }).waitFor();
  const message = page.locator(".agent-message.assistant");
  assert.equal(await message.locator("pre code").textContent(), 'value\n```~\n<img src="x">\n');
  assert.equal(await message.locator("img").count(), 0);
  assert.equal(await message.locator("a").count(), 1);
  assert.match(await message.innerText(), /\[unfinished\]\(\/file\)/);
  assert.equal(await message.getByRole("link", { name: "valid", exact: true }).getAttribute("href"), "https://example.test/file)");
  const selected = await page.locator(".agent-message.assistant").evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  assert.match(selected, /Browser SSE evidence/);
  assert.match(selected, /Second paragraph 订单/);
  await page.evaluate(() => window.getSelection().removeAllRanges());
  const thinking = message.locator("summary").filter({ hasText: "思考过程" });
  const reasoning = page.getByText("Browser reasoning evidence", { exact: true });
  assert.equal(await reasoning.count(), 0);
  await thinking.press("Enter");
  await reasoning.waitFor();
  await thinking.press("Space");
  await reasoning.waitFor({ state: "detached" });

  for (let index = 1; index <= 40; index += 1) publish({ type: "issue_user", message: `Browser history entry ${index}` });
  await page.getByText("Browser history entry 40", { exact: true }).waitFor();
  const atLatest = () =>
    page.waitForFunction(() => {
      const scroll = document.querySelector(".agent-scroll");
      return scroll && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 2;
    });
  await atLatest();
  await page.setViewportSize({ width: 1280, height: 800 });
  await atLatest();
  const transcript = page.locator(".agent-scroll");
  await transcript.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.getByRole("button", { name: "回到最新", exact: true }).waitFor();
  const send = page.getByRole("button", { name: "发送消息", exact: true });
  await draft.fill(Array.from({ length: 30 }, (_, index) => `Draft line ${index + 1}`).join("\n"));
  const [historyBounds, draftBounds, sendBounds] = await Promise.all([transcript.boundingBox(), draft.boundingBox(), send.boundingBox()]);
  assert.ok(historyBounds.height > 100 && historyBounds.y + historyBounds.height <= draftBounds.y);
  assert.ok(sendBounds.y >= draftBounds.y + draftBounds.height && sendBounds.y + sendBounds.height <= 800);
  assert.equal(await draft.evaluate((element) => element.scrollHeight > element.clientHeight), true);
  publish({ type: "issue_user", message: "Arrived while browsing history" });
  const unread = page.getByRole("button", { name: "1 条新消息", exact: true });
  await unread.waitFor();
  assert.equal(await transcript.evaluate((element) => element.scrollTop), 0);
  await unread.click();
  await atLatest();
  await unread.waitFor({ state: "detached" });
  const submittedText = "Browser click-to-send evidence";
  await draft.fill(submittedText);
  const sent = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/agent-messages"));
  await send.click();
  assert.equal((await sent).status(), 202);
  assert.equal(engine.messages.at(-1), submittedText);
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "发送给 Agent");
  assert.equal(await draft.inputValue(), "");
  const resources = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((entry) => entry.name.endsWith(".js"))
      .map((entry) => ({ url: new URL(entry.name).pathname, bytes: entry.encodedBodySize })),
  );
  assert.equal(
    resources.some(({ url }) => /jsonMode|json\.worker/.test(url)),
    false,
  );
  if (process.env.ISSUE_PILOT_BROWSER_ARTIFACTS) {
    await mkdir(process.env.ISSUE_PILOT_BROWSER_ARTIFACTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.ISSUE_PILOT_BROWSER_ARTIFACTS, "application.png"), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "浏览工单代码", exact: true }).click();
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("button", { name: "sample.json", exact: true }).click();
  await editor.waitFor();
  const bounds = await page.locator(".source-monaco-editor").boundingBox();
  assert.ok(bounds.width > 100 && bounds.height > 100 && bounds.x >= 0 && bounds.x + bounds.width <= 1280);
  if (process.env.ISSUE_PILOT_BROWSER_ARTIFACTS) {
    await page.screenshot({ path: path.join(process.env.ISSUE_PILOT_BROWSER_ARTIFACTS, "code-1280.png"), fullPage: true });
  }
  const unexpected = failures.filter((failure) => !/^Failed to load resource: the server responded with a status of 409/.test(failure));
  assert.deepEqual(unexpected, []);
  const inspection = openDatabase(databaseFile);
  try {
    assert.equal((await inspection.client.execute("PRAGMA integrity_check")).rows[0].integrity_check, "ok");
    assert.deepEqual((await inspection.client.execute("PRAGMA foreign_key_check")).rows, []);
  } finally {
    inspection.close();
  }
  const revision = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
  const sourceDiff = (await exec("git", ["diff", "HEAD", "--", "src", "package.json", "issue-pilot.config.ts"])).stdout;
  console.log(
    JSON.stringify(
      {
        chromium: browser.version(),
        revision,
        sourceDiffSha256: createHash("sha256").update(sourceDiff).digest("hex"),
        viewports: [{ width: 1680, height: 1050 }, page.viewportSize()],
        issue: issue.key,
        checks: [
          "real HTTP and SQLite",
          "isolated Git worktree",
          "JSON render",
          "find",
          "edit/save",
          "CRLF preservation",
          "clipboard paste",
          "undo/redo",
          "inline and side-by-side diff",
          "file switch",
          "conflict preserves disk and draft",
          "dirty navigation guard",
          "agent draft survives navigation",
          "lazy loading and icons",
          "real SSE",
          "Markdown fence and link parsing",
          "cross-paragraph selection",
          "keyboard toggle of lazily rendered thinking",
          "history scroll and unread indicator with real SSE",
          "long draft and accessible send control at 1280px",
          "click sends through HTTP and returns focus to composer",
          "1280px editor layout",
          "health and database integrity",
        ],
        resources,
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (page) {
    console.error(await page.locator("body").innerText());
    if (process.env.ISSUE_PILOT_BROWSER_ARTIFACTS) {
      await mkdir(process.env.ISSUE_PILOT_BROWSER_ARTIFACTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ISSUE_PILOT_BROWSER_ARTIFACTS, "failure.png"), fullPage: true });
    }
  }
  throw error;
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      await app?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
