import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { AgentEventBus } from "../../src/agent/events.ts";
import { buildApi } from "../../src/http/api.ts";
import { openDatabase } from "../../src/db/client.ts";
import { issueRepositories, issueWorkspaces, issues } from "../../src/db/schema.ts";
import { repositoryStorePath } from "../../src/workspace/git.ts";
import { issueRoot } from "../../src/workspace/state.ts";
import { prepareIssueRuntime } from "../../src/workspace/runtime.ts";
import { createService, createIssue, modelCatalog, servicePayload, TestAgentController } from "../http/fixture.ts";

// Playwright is optional verification tooling; install it outside the application checkout.
const { chromium } = await import(process.env.ISSUE_PILOT_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.ISSUE_PILOT_PLAYWRIGHT_MODULE).href : "playwright");
const exec = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-browser-"));
let app, browser, page;
try {
  const engine = new TestAgentController();
  const events = new AgentEventBus();
  const databaseFile = path.join(root, "issues.db");
  app = await buildApi({ stateRoot: root, databaseFile, engine, events, modelCatalog, logger: false, webRoot: path.resolve(process.env.ISSUE_PILOT_BROWSER_WEB_ROOT ?? "src/web/dist") });
  await createService(app, "browser", ["dev"]);
  const mdmRepositories = Array.from({ length: 24 }, (_, index) => `git@example.test:digital-biz-projects/mdm/servers/repository-${index}.git`);
  const mallRepository = "https://example.test/digital-biz-projects/xhgj-mall/fronts/mall.git";
  const groupedService = servicePayload("grouped", ["dev", "test"], [...mdmRepositories, mallRepository]);
  for (const { alias, url } of groupedService.repositories) {
    const registered = await app.inject({ method: "POST", url: "/api/repositories", payload: { name: alias, url, group: url === mallRepository ? "mall" : "mdm" } });
    assert.equal(registered.statusCode, 201, registered.body);
  }
  assert.equal((await app.inject({ method: "POST", url: "/api/services", payload: groupedService })).statusCode, 201);
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
  const copyBefore = '\texport const original = "订单\u00a0value";\r\n  export const stable = true;\r\n';
  const copyAfter = '\texport const modified = "订单\u00a0value";\r\n  export const stable = false;\r\n';
  await exec("git", ["init", "-b", "main", source]);
  await writeFile(path.join(source, "sample.json"), '{\r\n  "message": "original 订单",\r\n  "enabled": true\r\n}\r\n');
  await writeFile(path.join(source, "notes.ts"), "export const ready = true;\n");
  await writeFile(path.join(source, "copy-whitespace.ts"), copyBefore);
  await exec("git", ["-C", source, "add", "."]);
  await exec("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Initial fixture"]);
  const commit = (await exec("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  const store = repositoryStorePath(root, url);
  await mkdir(path.dirname(store), { recursive: true });
  await exec("git", ["clone", "--bare", source, store]);
  const checkout = path.join(issueRoot(root, issue.key), "application");
  const branch = "browser-fixture";
  await exec("git", ["--git-dir", store, "worktree", "add", "-b", branch, checkout, "main"]);
  await writeFile(path.join(checkout, "copy-whitespace.ts"), copyAfter);
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
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--host-resolver-rules=MAP issue-pilot.test 127.0.0.1", "--no-proxy-server"] });
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
  const verifyDiffCopy = async (copyPage, secure) => {
    assert.equal(await copyPage.evaluate(() => isSecureContext), secure);
    assert.equal(await copyPage.evaluate(() => typeof navigator.clipboard), secure ? "object" : "undefined");
    await copyPage.getByRole("button", { name: "查看差异 copy-whitespace.ts", exact: true }).click();
    await copyPage.locator(".source-diff-summary .added").filter({ hasText: "+2" }).waitFor();
    const copy = async (label, expected, perform) => {
      // A trusted localhost page reads the real clipboard after copying from the HTTP page.
      await page.bringToFront();
      await page.evaluate(() => navigator.clipboard.writeText("copy sentinel"));
      await copyPage.bringToFront();
      await perform();
      await page.bringToFront();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected, `${secure ? "localhost" : "HTTP"} ${label}`);
    };
    await copyPage.locator(".source-editor").hover();
    await copyPage.getByRole("button", { name: "并排", exact: true }).click();
    for (const [side, expected] of [
      ["original", copyBefore],
      ["modified", copyAfter],
    ]) {
      await copy(side, expected, async () => {
        const input = copyPage.locator(`.monaco-diff-editor .editor.${side} textarea.inputarea`);
        await input.press("Control+a");
        await input.press("Control+c");
      });
    }
    await copyPage.locator(".source-editor").hover();
    await copyPage.getByRole("button", { name: "行内", exact: true }).click();
    const deletedLines = copyPage.locator(".line-delete-selectable .view-line");
    await deletedLines.first().waitFor();
    for (const method of ["keyboard", "copy event"]) {
      await copy(`inline deletion ${method}`, copyBefore.slice(0, -2), async () => {
        const endpoints = await deletedLines.evaluateAll((lines) => {
          const endpoint = (element, atEnd) => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let text = walker.nextNode();
            if (atEnd) while (walker.nextNode()) text = walker.currentNode;
            const caret = document.createRange();
            caret.setStart(text, atEnd ? text.length : 0);
            caret.collapse(true);
            const box = caret.getBoundingClientRect();
            return { x: box.x + (atEnd ? -0.3 : 0.3), y: box.y + box.height / 2 };
          };
          return { start: endpoint(lines[0], false), end: endpoint(lines.at(-1), true) };
        });
        await copyPage.mouse.move(endpoints.start.x, endpoints.start.y);
        await copyPage.mouse.down();
        await copyPage.mouse.move(endpoints.end.x, endpoints.end.y, { steps: 10 });
        await copyPage.mouse.up();
        const selected = await copyPage.evaluate(() => window.getSelection()?.toString());
        assert.match(selected, /original/);
        if (method === "keyboard") await copyPage.keyboard.press("Control+c");
        else assert.equal(await copyPage.evaluate(() => document.execCommand("copy")), true);
        assert.equal(await copyPage.evaluate(() => window.getSelection()?.toString()), selected, "copy preserves the native selection");
      });
    }
    await copyPage.getByRole("button", { name: "关闭差异", exact: true }).click();
  };
  await verifyDiffCopy(page, true);
  const httpPage = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
  try {
    await httpPage.goto(`${origin.replace("127.0.0.1", "issue-pilot.test")}/?issue=${issue.key}`);
    await httpPage.getByRole("button", { name: "浏览工单代码", exact: true }).click();
    await httpPage.getByRole("button", { name: "变更", exact: true }).click();
    await verifyDiffCopy(httpPage, false);
  } finally {
    await httpPage.close();
  }
  assert.equal(await readFile(path.join(checkout, "copy-whitespace.ts"), "utf8"), copyAfter);
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
  const composerFocus = await draft.evaluate((element) => {
    const composer = getComputedStyle(element.closest(".agent-composer"));
    return { outline: composer.outlineStyle, borderWidth: composer.borderTopWidth, borderColor: composer.borderTopColor, inputOutline: getComputedStyle(element).outlineStyle };
  });
  assert.deepEqual(composerFocus, { outline: "none", borderWidth: "2px", borderColor: "rgb(138, 190, 183)", inputOutline: "none" });
  await page.getByRole("radio", { name: "首页", exact: true }).click();
  await page.getByRole("radio", { name: "工单", exact: true }).click();
  await draft.waitFor();
  assert.equal(await draft.inputValue(), "unsent browser draft");
  for (const width of [960, 980, 1020, 1180, 1200, 1260]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => ({
      contentWidth: document.querySelector(".app-content").scrollWidth,
      detailRight: document.querySelector(".issue-workspace").getBoundingClientRect().right,
    }));
    assert.ok(layout.contentWidth <= width && layout.detailRight <= width, `Issue actions are clipped at ${width}px: ${JSON.stringify(layout)}`);
  }
  await page.setViewportSize({ width: 1680, height: 1050 });
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
      usage: {
        input: 8_000,
        output: 960,
        cacheRead: 8_000,
        cacheWrite: 1_040,
        totalTokens: 18_000,
        cost: { input: 1, output: 1, cacheRead: 2, cacheWrite: 1.767, total: 5.767, totalFromProvider: false },
      },
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
  const usageGroup = page.getByRole("group", { name: "会话用量", exact: true });
  await usageGroup.getByText("$5.767 (估算)", { exact: true }).waitFor();
  assert.equal(await usageGroup.getByText("CH46.9%", { exact: true }).getAttribute("title"), "最近一次主模型请求的缓存命中率");
  for (const width of [1680, 1200, 980, 520, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await usageGroup.evaluate((element) => {
      const footer = element.closest("footer").getBoundingClientRect();
      return [...element.children].map((metric) => {
        const bounds = metric.getBoundingClientRect();
        return { text: metric.textContent, visible: bounds.left >= footer.left && bounds.right <= footer.right && metric.scrollWidth <= metric.clientWidth };
      });
    });
    assert.ok(layout.length === 7 && layout.every((metric) => metric.visible), `Usage metrics are clipped at ${width}px: ${JSON.stringify(layout)}`);
  }
  await page.setViewportSize({ width: 1680, height: 1050 });
  await page.locator(".agent-scroll").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const reasoning = page.getByText("Browser reasoning evidence", { exact: true });
  await reasoning.waitFor();
  assert.equal(await message.locator(".agent-thinking details, .agent-thinking summary").count(), 0);
  await page.setViewportSize({ width: 1920, height: 1050 });
  const transcriptWidth = await page.locator(".agent-scroll").evaluate((element) => element.clientWidth);
  const conversationWidth = await page.locator(".agent-conversation").evaluate((element) => element.getBoundingClientRect().width);
  assert.ok(transcriptWidth > 960 && Math.abs(transcriptWidth - conversationWidth) < 2, `Conversation width ${conversationWidth} does not fill ${transcriptWidth}`);
  await page.setViewportSize({ width: 1680, height: 1050 });

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
  // Keep this tall fixture after the history scenarios so its reflow does not change their scroll baseline.
  publish({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            `Long paragraph evidence ${"采购单核实结论与生产证据。".repeat(100)}`,
            `Long identifier evidence \`${"order_trace_".repeat(120)}\``,
            `| 时间 | 核实结果 |\n| --- | --- |\n| 11 月 5 日 13:40 | ${"生产接口返回关联采购单状态与核实结果。".repeat(50)} |`,
            `| ${Array.from({ length: 48 }, (_, index) => `列${index}`).join(" | ")} |\n| ${Array(48).fill("---").join(" | ")} |\n| ${Array(48).fill("证据").join(" | ")} |`,
          ].join("\n\n"),
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
  const overflowMessage = page.locator(".agent-message.assistant").filter({ hasText: "Long paragraph evidence" });
  await overflowMessage.waitFor();
  for (const width of [1280, 1680, 1920]) {
    await page.setViewportSize({ width, height: 1050 });
    const layout = await overflowMessage.evaluate((element) => {
      const scroll = element.closest(".agent-scroll");
      const body = element.querySelector(".markdown-body");
      const bounds = body.getBoundingClientRect();
      const paragraph = [...body.querySelectorAll("p")].find((p) => p.textContent.startsWith("Long paragraph evidence"));
      const identifier = [...body.querySelectorAll("p")].find((p) => p.textContent.startsWith("Long identifier evidence"));
      const wideTable = body.querySelectorAll("table")[1];
      return {
        bodyFits: bounds.right <= scroll.getBoundingClientRect().right,
        noMessageOverflow: element.scrollWidth <= element.clientWidth + 1,
        paragraphWraps: paragraph.offsetHeight > parseFloat(getComputedStyle(paragraph).lineHeight) * 2,
        identifierFits: identifier.scrollWidth <= identifier.clientWidth + 1,
        tableFits: wideTable.getBoundingClientRect().right <= bounds.right + 1,
        tableScrolls: wideTable.scrollWidth > wideTable.clientWidth && getComputedStyle(wideTable).overflowX === "auto",
      };
    });
    assert.ok(Object.values(layout).every(Boolean), `Markdown overflow at ${width}px: ${JSON.stringify(layout)}`);
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
  for (let index = 0; index < 20; index += 1) {
    const suffix = String(index).padStart(2, "0");
    const email = `member-${suffix}@example.test`;
    const response = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject },
      payload: { subject: email, name: `Scroll fixture member ${suffix}`, email, role: "product" },
    });
    assert.equal(response.statusCode, 201, response.body);
  }
  await page.getByRole("button", { name: "关闭代码浏览器", exact: true }).click();
  for (let index = 0; index < 300; index += 1) {
    const registered = await app.inject({
      method: "POST",
      url: "/api/repositories",
      payload: { name: `Repository ${index}`, url: `git@example.test:repo-${String(index).padStart(3, "0")}.git`, group: "other" },
    });
    assert.equal(registered.statusCode, 201, registered.body);
  }
  const longName = "example-mall-docking-chinarailway";
  const longUrl = `git@example.test:digital-biz-projects/example/docking-servers/${longName}.git`;
  const longRepository = await app.inject({ method: "POST", url: "/api/repositories", payload: { name: longName, url: longUrl, group: "other" } });
  assert.equal(longRepository.statusCode, 201, longRepository.body);
  await createService(app, "ai-platform", ["test"], [longUrl]);
  await page.getByRole("radio", { name: "配置", exact: true }).click();
  await page.getByRole("tab", { name: "仓库", exact: true }).click();
  const repositoryList = page.getByRole("region", { name: "仓库列表", exact: true });
  await repositoryList.getByText("Repository 299", { exact: true }).waitFor({ state: "attached" });
  for (const width of [1280, 520]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await repositoryList.getAttribute("tabindex"), "0");
    assert.equal(await repositoryList.evaluate((element) => element.scrollHeight > element.clientHeight && getComputedStyle(element).overflowY === "auto"), true);
    await repositoryList.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const listBounds = await repositoryList.boundingBox();
    const lastBounds = await repositoryList.getByRole("row").last().boundingBox();
    assert.ok(lastBounds.y >= listBounds.y && lastBounds.y + lastBounds.height <= listBounds.y + listBounds.height + 1);
    assert.equal(await page.getByRole("button", { name: "登记仓库", exact: true }).isVisible(), true);
    const longRow = repositoryList.getByRole("row").filter({ has: page.getByText(longName, { exact: true }) });
    await longRow.scrollIntoViewIfNeeded();
    const nameCell = longRow.getByText(longName, { exact: true });
    const addressCell = longRow.getByText(longUrl, { exact: true });
    const serviceCell = longRow.getByRole("button", { name: "ai-platform", exact: true });
    assert.equal(await nameCell.getAttribute("title"), longName);
    assert.equal(await addressCell.getAttribute("title"), longUrl);
    assert.equal(await serviceCell.getAttribute("title"), "ai-platform");
    assert.equal(await addressCell.evaluate((element) => getComputedStyle(element).whiteSpace), "nowrap");
    assert.ok((await addressCell.boundingBox()).height <= 20);
    assert.ok((await serviceCell.boundingBox()).height <= 32);
    if (width === 1280) assert.ok((await longRow.boundingBox()).height <= 56);
    assert.equal(await repositoryList.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    if (process.env.ISSUE_PILOT_BROWSER_ARTIFACTS) await page.screenshot({ path: path.join(process.env.ISSUE_PILOT_BROWSER_ARTIFACTS, `repositories-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("tab", { name: "服务", exact: true }).click();
  const compactTabs = page.getByRole("tablist", { name: "服务列表", exact: true });
  await compactTabs.getByRole("tab").first().waitFor();
  const compactBounds = await compactTabs.boundingBox();
  const compactToolbar = await page.locator(".service-toolbar-inner").boundingBox();
  assert.ok(compactBounds.width < compactToolbar.width / 2);
  assert.ok(Math.abs(compactBounds.x + compactBounds.width / 2 - compactToolbar.x - compactToolbar.width / 2) < 1);
  assert.equal(await compactTabs.evaluate((element) => getComputedStyle(element).overflowY === "hidden" && element.scrollHeight <= element.clientHeight), true);
  const descriptionLines = Array.from({ length: 32 }, (_, index) => `Service description fixture paragraph ${index + 1}.`);
  const longDescription = await app.inject({
    method: "POST",
    url: "/api/services",
    headers: { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject },
    payload: { ...servicePayload("description-scroll", ["test"], [mallRepository]), description: descriptionLines.join("\n\n") },
  });
  assert.equal(longDescription.statusCode, 201, longDescription.body);
  for (let index = 0; index < 20; index += 1) await createService(app, `demo-namespace-${String(index).padStart(2, "0")}-servers`, ["test"]);
  await page.reload();
  await page.getByRole("radio", { name: "配置", exact: true }).click();
  await page.getByRole("tab", { name: "服务", exact: true }).click();
  const serviceTabs = page.getByRole("tablist", { name: "服务列表", exact: true });
  const serviceActions = page.getByRole("group", { name: "服务操作", exact: true });
  await serviceTabs.getByRole("tab", { name: "demo-namespace-19-servers", exact: true }).waitFor({ state: "attached" });
  for (const width of [1280, 700, 520]) {
    await page.setViewportSize({ width, height: 800 });
    const tabBounds = await serviceTabs.boundingBox();
    const toolbarInnerBounds = await page.locator(".service-toolbar-inner").boundingBox();
    assert.ok(Math.abs(tabBounds.x + tabBounds.width / 2 - toolbarInnerBounds.x - toolbarInnerBounds.width / 2) < 1);
    assert.equal(
      await serviceTabs.evaluate((element) => {
        const style = getComputedStyle(element);
        return style.overflowY === "hidden" && style.scrollbarWidth === "none" && element.scrollHeight <= element.clientHeight;
      }),
      true,
    );
    const actionBounds = await serviceActions.boundingBox();
    assert.ok(tabBounds.x >= 0 && actionBounds.x + actionBounds.width <= width);
    if (width > 700) assert.ok(Math.round(actionBounds.x - tabBounds.x - tabBounds.width) >= 8, JSON.stringify({ width, tabBounds, actionBounds }));
    else assert.ok(tabBounds.y + tabBounds.height + 4 <= actionBounds.y);
    assert.equal(await serviceTabs.evaluate((element) => element.scrollWidth > element.clientWidth), true);
    const lastService = serviceTabs.getByRole("tab", { name: "demo-namespace-19-servers", exact: true });
    await lastService.scrollIntoViewIfNeeded();
    await lastService.click();
    assert.equal(await lastService.getAttribute("aria-selected"), "true");
    const activeStyle = await lastService.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      radius: getComputedStyle(element).borderRadius,
      border: getComputedStyle(element).borderBottomWidth,
    }));
    assert.deepEqual(activeStyle, { background: "rgb(255, 255, 255)", radius: "6px", border: "0px" });
    assert.equal(await page.getByRole("combobox", { name: "选择服务", exact: true }).count(), 0);
    assert.equal(await serviceActions.getByRole("button", { name: "添加", exact: true }).isVisible(), true);
    assert.equal(await serviceActions.getByRole("button", { name: "编辑", exact: true }).isVisible(), true);
    assert.equal(
      await page.locator(".service-toolbar").evaluate((element) => {
        const style = getComputedStyle(element);
        return style.backgroundColor === "rgb(241, 244, 242)" && style.borderRadius === "8px" && style.borderTopWidth === "0px";
      }),
      true,
    );
    const toolbarBounds = await page.locator(".service-toolbar").boundingBox();
    const detailBounds = await page.locator(".service-detail").boundingBox();
    assert.ok(Math.abs(toolbarBounds.x - detailBounds.x) < 1 && Math.abs(toolbarBounds.width - detailBounds.width) < 1);
    await page.locator(".service-detail h2").first().click();
    if (process.env.ISSUE_PILOT_BROWSER_ARTIFACTS) await page.screenshot({ path: path.join(process.env.ISSUE_PILOT_BROWSER_ARTIFACTS, `services-${width}.png`), fullPage: true });
  }
  await serviceActions.getByRole("button", { name: "编辑", exact: true }).click();
  const serviceDialog = page.getByRole("dialog", { name: "编辑服务", exact: true });
  await serviceDialog.waitFor();
  await serviceDialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("radio", { name: "配置", exact: true }).click();
  const settingsTabs = page.getByRole("tablist", { name: "配置分类" });
  const repositoryListRequests = [];
  const recordRepositoryList = (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/repositories") repositoryListRequests.push(url.pathname + url.search);
  };
  page.on("request", recordRepositoryList);
  await settingsTabs.getByRole("tab", { name: "仓库", exact: true }).click();
  const repositories = page.getByRole("region", { name: "仓库管理" });
  const list = repositories.getByRole("region", { name: "仓库列表" });
  const add = repositories.getByRole("button", { name: "登记仓库" });
  const group = repositories.getByRole("combobox", { name: "仓库分组" });
  const assertSubtleScrollbar = async (area) => {
    const style = await area.evaluate((node) => {
      const { scrollbarWidth, scrollbarColor, scrollbarGutter } = getComputedStyle(node);
      return { scrollbarWidth, scrollbarColor, scrollbarGutter };
    });
    assert.equal(style.scrollbarWidth, "thin");
    assert.match(style.scrollbarColor, / rgba\(0, 0, 0, 0\)$/);
    assert.equal(style.scrollbarGutter, "auto");
  };
  const assertHiddenScrollbar = async (area) => {
    assert.equal(await area.evaluate((node) => getComputedStyle(node).scrollbarWidth), "none");
  };
  const scrollToEnd = async (area, visibleScrollbar = true) => {
    const tabsTop = (await settingsTabs.boundingBox()).y;
    assert.ok(await area.evaluate((node) => getComputedStyle(node).overflowY === "auto" && node.scrollHeight > node.clientHeight));
    if (visibleScrollbar) await assertSubtleScrollbar(area);
    else await assertHiddenScrollbar(area);
    await area.press("End");
    await page.waitForFunction((node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 1, await area.elementHandle());
    assert.equal((await settingsTabs.boundingBox()).y, tabsTop);
  };
  const selectGroup = async (name) => {
    await group.click();
    await page.getByRole("listbox", { name: "仓库分组" }).getByRole("option", { name, exact: true }).click();
  };
  await list.getByText(mallRepository, { exact: true }).waitFor();
  assert.deepEqual(repositoryListRequests, ["/api/repositories"]);
  assert.equal(await group.innerText(), "全部");
  const addPosition = await add.boundingBox();
  await scrollToEnd(list);
  assert.deepEqual(await add.boundingBox(), addPosition);
  await selectGroup("mdm");
  await list.getByText(mdmRepositories[0], { exact: true }).waitFor();
  assert.equal(await list.getByText(mallRepository, { exact: true }).count(), 0);
  await page.waitForFunction((node) => node.scrollTop === 0, await list.elementHandle());
  await selectGroup("mall");
  await list.getByText(mallRepository, { exact: true }).waitFor();
  assert.equal(await list.getByText(mdmRepositories[0], { exact: true }).count(), 0);
  assert.ok(await list.evaluate((node) => node.scrollHeight === node.clientHeight && node.offsetWidth === node.clientWidth));
  await selectGroup("全部");
  assert.deepEqual(repositoryListRequests, ["/api/repositories"]);
  await add.click();
  const registration = page.getByRole("dialog", { name: "登记仓库" });
  const customGroupRepo = "git@example.test:digital-biz-projects/mdm/custom-group-fixture.git";
  await registration.getByRole("textbox", { name: "仓库地址" }).fill(customGroupRepo);
  await registration.getByRole("combobox", { name: "仓库分组" }).click();
  await page.getByRole("option", { name: "新建分组…" }).click();
  await registration.getByRole("textbox", { name: "新分组名称" }).fill("Platform Ops");
  await registration.getByRole("button", { name: "保存" }).click();
  await registration.waitFor({ state: "hidden" });
  await list.getByText(customGroupRepo, { exact: true }).waitFor();
  await selectGroup("platform ops");
  await list.getByText(customGroupRepo, { exact: true }).waitFor();
  assert.equal(await list.getByText(mdmRepositories[0], { exact: true }).count(), 0);
  await list.getByRole("button", { name: "编辑", exact: true }).click();
  const repositoryEdit = page.getByRole("dialog", { name: "编辑仓库" });
  const editGroup = repositoryEdit.getByRole("combobox", { name: "仓库分组" });
  assert.equal(await editGroup.innerText(), "platform ops");
  await editGroup.click();
  await page.getByRole("option", { name: "mall", exact: true }).click();
  await repositoryEdit.getByRole("button", { name: "保存" }).click();
  await repositoryEdit.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector('.repository-toolbar [aria-label="仓库分组"]')?.textContent === "全部");
  await selectGroup("mall");
  await list.getByText(customGroupRepo, { exact: true }).waitFor();
  await selectGroup("全部");
  assert.ok(repositoryListRequests.every((url) => url === "/api/repositories"));
  page.off("request", recordRepositoryList);

  const settingsViewport = { width: 520, height: 540 };
  await page.setViewportSize(settingsViewport);
  await scrollToEnd(list);
  for (const control of [group, add]) {
    const box = await control.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= settingsViewport.width);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await settingsTabs.getByRole("tab", { name: "用户", exact: true }).click();
  const usersPanel = page.getByRole("tabpanel", { name: "用户", exact: true });
  const people = usersPanel.getByRole("region", { name: "人员列表" });
  const credentials = usersPanel.getByRole("region", { name: "我的凭证" });
  const searchPeople = usersPanel.getByRole("textbox", { name: "搜索人员" });
  const addPerson = usersPanel.getByRole("button", { name: "添加人员" });
  const tableHeading = people.getByRole("columnheader", { name: "成员" });
  await people.getByText("Scroll fixture member 19", { exact: true }).waitFor();
  const fixedControls = [credentials, searchPeople, addPerson, tableHeading];
  const fixedPositions = await Promise.all(fixedControls.map((control) => control.boundingBox()));
  await scrollToEnd(people);
  assert.deepEqual(await Promise.all(fixedControls.map((control) => control.boundingBox())), fixedPositions);
  assert.ok(await usersPanel.evaluate((node) => node.scrollHeight === node.clientHeight));
  await searchPeople.fill("member 19");
  assert.equal(await people.getByText("Scroll fixture member 00", { exact: true }).count(), 0);
  assert.ok(await people.evaluate((node) => node.scrollHeight === node.clientHeight && node.offsetWidth === node.clientWidth));
  await searchPeople.clear();
  await page.setViewportSize(settingsViewport);
  await people.scrollIntoViewIfNeeded();
  await scrollToEnd(people);

  const endpointsViewport = { width: 1280, height: 1100 };
  await page.setViewportSize(endpointsViewport);
  await settingsTabs.getByRole("tab", { name: "端点", exact: true }).click();
  const endpointsPanel = page.getByRole("tabpanel", { name: "端点", exact: true });
  const toolsToggle = endpointsPanel.locator(".endpoint-tools > summary");
  const tools = endpointsPanel.getByRole("region", { name: "工具列表" });
  const copyConfig = endpointsPanel.getByRole("button", { name: "复制配置" });
  await toolsToggle.waitFor();
  const assertPanelFixed = async (panel) => {
    assert.deepEqual(
      await panel.evaluate((node) => {
        node.scrollTop = 200;
        return [node.scrollTop, node.closest(".app-content").scrollTop, window.scrollY];
      }),
      [0, 0, 0],
    );
  };
  for (const viewport of [endpointsViewport, { width: 1280, height: 800 }, settingsViewport]) {
    await page.setViewportSize(viewport);
    await tools.waitFor({ state: "hidden" });
    const preview = endpointsPanel.getByLabel("MCP 客户端配置");
    assert.ok(await preview.evaluate((node) => node.scrollWidth === node.clientWidth));
    const fixed = [copyConfig, toolsToggle];
    const positions = await Promise.all(fixed.map((control) => control.boundingBox()));
    await toolsToggle.press("Enter");
    await tools.waitFor();
    const toolsBounds = await tools.boundingBox();
    const panelBounds = await endpointsPanel.boundingBox();
    assert.ok(toolsBounds.height > 0 && toolsBounds.y + toolsBounds.height <= panelBounds.y + panelBounds.height + 1, JSON.stringify({ viewport, toolsBounds, panelBounds }));
    await scrollToEnd(tools);
    await tools.hover();
    await page.mouse.wheel(0, 500);
    await assertPanelFixed(endpointsPanel);
    assert.deepEqual(await Promise.all(fixed.map((control) => control.boundingBox())), positions);
    await toolsToggle.click();
    await tools.waitFor({ state: "hidden" });
    assert.deepEqual(await toolsToggle.boundingBox(), positions[1]);
  }

  await settingsTabs.getByRole("tab", { name: "参数", exact: true }).click();
  const parametersPanel = page.getByRole("tabpanel", { name: "参数", exact: true });
  const parameters = parametersPanel.getByRole("region", { name: "参数表单" });
  const saveParameters = parametersPanel.getByRole("button", { name: "保存参数" });
  await saveParameters.waitFor();
  const savePosition = await saveParameters.boundingBox();
  await assertHiddenScrollbar(parametersPanel);
  await scrollToEnd(parameters, false);
  assert.deepEqual(await saveParameters.boundingBox(), savePosition);
  const networkMode = parameters.getByRole("combobox", { name: "工单网络访问" });
  assert.equal(await networkMode.textContent(), "开放网络");
  assert.equal(await parameters.getByRole("textbox", { name: "Agent 网络基础白名单" }).count(), 0);
  const lastParameter = parameters.getByRole("textbox", { name: "钉钉附件主机" });
  const formBounds = await parameters.boundingBox();
  const lastParameterBounds = await lastParameter.boundingBox();
  assert.ok(lastParameterBounds.y >= formBounds.y && lastParameterBounds.y + lastParameterBounds.height <= formBounds.y + formBounds.height + 1);
  await page.setViewportSize({ width: 1280, height: 800 });
  assert.ok(await parameters.evaluate((node) => node.scrollHeight === node.clientHeight));

  await networkMode.click();
  await page.getByRole("option", { name: "域名白名单", exact: true }).click();
  const allowedDomains = parameters.getByRole("textbox", { name: "Agent 网络基础白名单" });
  await allowedDomains.fill("gitlab.example.test:443");
  const saveNetworkMode = async () => {
    const saved = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith("/api/config/parameters"));
    await saveParameters.click();
    const response = await saved;
    assert.equal(response.status(), 200);
    return response.json();
  };
  const restrictedNetwork = await saveNetworkMode();
  assert.equal(restrictedNetwork.values.networkMode, "allowlist");
  assert.deepEqual(restrictedNetwork.values.networkAllowedDomains, ["gitlab.example.test:443"]);
  await networkMode.click();
  await page.getByRole("option", { name: "开放网络", exact: true }).click();
  assert.equal(await allowedDomains.count(), 0);
  const openNetwork = await saveNetworkMode();
  assert.equal(openNetwork.values.networkMode, "open");
  assert.deepEqual(openNetwork.values.networkAllowedDomains, ["gitlab.example.test:443"]);

  await settingsTabs.getByRole("tab", { name: "服务", exact: true }).click();
  const servicesPanel = page.getByRole("tabpanel", { name: "服务", exact: true });
  const serviceTabsList = page.getByRole("tablist", { name: "服务列表" });
  const descriptionTab = serviceTabsList.getByRole("tab", { name: "description-scroll", exact: true });
  const serviceDetail = servicesPanel.getByRole("region", { name: "服务描述", exact: true });
  const branchTable = servicesPanel.getByRole("region", { name: "仓库与环境分支" });
  const lastParagraph = serviceDetail.locator("p").last();
  for (const viewport of [{ width: 1280, height: 800 }, settingsViewport]) {
    await page.setViewportSize(viewport);
    await descriptionTab.click();
    await lastParagraph.waitFor();
    await assertPanelFixed(servicesPanel);
    const fixed = [page.locator(".service-toolbar"), servicesPanel.getByRole("heading", { name: "代码分支" }), branchTable];
    const positions = await Promise.all(fixed.map((control) => control.boundingBox()));
    await assertHiddenScrollbar(branchTable);
    assert.ok(await branchTable.evaluate((node) => node.scrollHeight === node.clientHeight));
    await scrollToEnd(serviceDetail);
    assert.deepEqual(await Promise.all(fixed.map((control) => control.boundingBox())), positions);
    const detailBounds = await serviceDetail.boundingBox();
    const paragraphBounds = await lastParagraph.boundingBox();
    assert.ok(
      detailBounds.height >= 48 && paragraphBounds.y >= detailBounds.y && paragraphBounds.y + paragraphBounds.height <= detailBounds.y + detailBounds.height + 1,
      JSON.stringify({ viewport, detailBounds, paragraphBounds }),
    );
    await serviceTabsList.getByRole("tab", { name: "grouped", exact: true }).click();
    await page.waitForFunction((node) => node.scrollTop === 0, await serviceDetail.elementHandle());
    await branchTable.press("End");
    await page.waitForFunction((node) => node.scrollTop > 0 && node.scrollTop + node.clientHeight >= node.scrollHeight - 1, await branchTable.elementHandle());
    await assertPanelFixed(servicesPanel);
  }
  for (let index = 1; index <= 6; index += 1) await createIssue(app, "browser", "dev", `Home scroll fixture ${index}`);
  engine.running.clear();
  const homeViewports = [
    { width: 1280, height: 800 },
    { width: 1220, height: 540 },
    { width: 568, height: 320 },
    { width: 390, height: 570 },
  ];
  await page.getByRole("radio", { name: "首页", exact: true }).click();
  const home = page.getByRole("main", { name: "首页", exact: true });
  const activity = home.getByRole("list", { name: "待处理工单" });
  const summary = home.getByRole("region", { name: "当前运营状态" });
  const overviewTitle = home.getByRole("heading", { name: "运营总览", exact: true });
  const insightTitle = home.getByRole("heading", { name: "运营洞察", exact: true });
  const insightTabs = home.getByRole("tablist", { name: "统计分类" });
  const output = insightTabs.getByRole("tab", { name: "产出" });
  const assertHomeFixed = async () => {
    assert.deepEqual(await home.evaluate((node) => [node.scrollTop, node.scrollLeft, node.parentElement.scrollTop, window.scrollY]), [0, 0, 0, 0]);
  };
  await home.getByText("Home scroll fixture 1", { exact: true }).waitFor();
  for (const viewport of homeViewports) {
    await page.setViewportSize(viewport);
    const box = await home.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= viewport.width, `Home bounds ${box.x}+${box.width} exceed viewport ${viewport.width}`);
    const summaryPosition = await summary.boundingBox();
    const tabPosition = await insightTabs.boundingBox();
    const overviewHeading = await overviewTitle.boundingBox();
    const insightHeading = await insightTitle.boundingBox();
    assert.equal(overviewHeading.x, summaryPosition.x);
    assert.equal(insightHeading.x, tabPosition.x);
    if (summaryPosition.x === tabPosition.x) assert.equal(summaryPosition.width, tabPosition.width);
    else assert.equal(overviewHeading.y, insightHeading.y);
    assert.ok(tabPosition.y + tabPosition.height < viewport.height, `Statistics tabs clipped at ${viewport.width}x${viewport.height}`);
    await home.evaluate((node) => node.scrollTo(300, 300));
    await page.mouse.move(summaryPosition.x + summaryPosition.width / 2, summaryPosition.y + summaryPosition.height / 2);
    await page.mouse.wheel(0, 600);
    await output.press("End");
    await assertHomeFixed();

    assert.ok(await activity.evaluate((node) => node.clientHeight > 0 && node.scrollHeight > node.clientHeight));
    await assertHiddenScrollbar(activity);
    await activity.press("End");
    await page.waitForFunction((node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 1, await activity.elementHandle());
    await assertHomeFixed();
    assert.deepEqual(await summary.boundingBox(), summaryPosition);
    assert.deepEqual(await insightTabs.boundingBox(), tabPosition);
  }
  await insightTabs.getByRole("tab", { name: "团队", exact: true }).click();
  const assigneeTable = home.getByRole("region", { name: "处理人统计", exact: true });
  assert.ok(await assigneeTable.evaluate((node) => node.scrollWidth > node.clientWidth));
  await assertHiddenScrollbar(assigneeTable);
  await assigneeTable.press("ArrowRight");
  await page.waitForFunction((node) => node.scrollLeft > 0, await assigneeTable.elementHandle());
  await assertHomeFixed();
  await insightTabs.getByRole("tab", { name: "分布", exact: true }).click();
  const distribution = home.getByRole("region", { name: "工单分布", exact: true });
  await assertHiddenScrollbar(distribution);
  await distribution.press("ArrowRight");
  await page.waitForFunction((node) => node.scrollLeft > 0, await distribution.elementHandle());
  await insightTabs.getByRole("tab", { name: "资源", exact: true }).click();
  const resourcePanel = home.getByRole("tabpanel");
  await resourcePanel.getByText("共享 Git 占用", { exact: true }).waitFor();
  assert.ok(await resourcePanel.evaluate((node) => node.scrollHeight > node.clientHeight));
  await resourcePanel.press("End");
  await page.waitForFunction((node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 1, await resourcePanel.elementHandle());
  await assertHomeFixed();
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
        viewports: [
          { width: 1680, height: 1050 },
          { width: 1920, height: 1050 },
          { width: 1280, height: 800 },
          { width: 700, height: 800 },
          { width: 520, height: 800 },
          settingsViewport,
          endpointsViewport,
          ...homeViewports,
        ],
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
          "read-only diff copy on localhost and HTTP preserves tabs, NBSP, CRLF and the selection",
          "workbench columns remain visible between responsive breakpoints",
          "usage metrics wrap without truncating cost or context on desktop and narrow screens",
          "file switch",
          "conflict preserves disk and draft",
          "dirty navigation guard",
          "agent draft survives navigation",
          "lazy loading and icons",
          "real SSE",
          "Markdown fence and link parsing",
          "cross-paragraph selection",
          "thinking rendered inline without disclosure controls",
          "full-width conversation on a wide viewport",
          "long paragraphs and identifiers wrap without message overflow; wide tables scroll locally at 1280/1680/1920px",
          "300 repositories scroll in a focusable region on desktop and mobile",
          "long repository names and URLs stay on one line with full titles",
          "service labels do not split across lines",
          "composer focus uses a single border without a second outline",
          "service Tabs retain their original rounded rail and white selected pill",
          "service Tabs shrink to content, stay centered and never show a vertical scrollbar",
          "service toolbar stays fixed while long descriptions scroll inside the detail card",
          "history scroll and unread indicator with real SSE",
          "long draft and accessible send control at 1280px",
          "click sends through HTTP and returns focus to composer",
          "1280px editor layout",
          "unfiltered repository GET, local group filtering and manual group assignment",
          "independent personnel list and expanded endpoint tool list scrolling on desktop and narrow screens",
          "fixed endpoint panel with scrollable tools; parameter save action stays visible on narrow screens",
          "network modes save through HTTP and preserve the hidden allowlist in open mode",
          "fixed home layout for wheel, keyboard and programmatic scrolling, with reachable activity and statistics on desktop and mobile",
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
