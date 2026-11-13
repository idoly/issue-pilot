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
import { createPrivateSessionManager } from "../../src/agent/pi-session.ts";
import { persistNestedQuery, savedQueryCompletion } from "../../src/agent/query-results.ts";
import { buildApi } from "../../src/http/api.ts";
import { openDatabase } from "../../src/db/client.ts";
import { agentSessions, issueRelations, issueRepositories, issueWorkspaces, issues } from "../../src/db/schema.ts";
import { issueRepositoryStorePath, repositoryStorePath } from "../../src/workspace/git.ts";
import { isolateIssueWorktree } from "../../src/workspace/issue-git.ts";
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
  const searchTargetTitle = "审批提交后一直转圈";
  const searchTarget = await createIssue(app, "browser", "dev", searchTargetTitle);
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
  await exec("git", ["-C", store, "remote", "set-url", "origin", url]);
  const checkout = path.join(issueRoot(root, issue.key), "application");
  const branch = "browser-fixture";
  await exec("git", ["--git-dir", store, "worktree", "add", "-b", branch, checkout, "main"]);
  await isolateIssueWorktree(store, issueRepositoryStorePath(root, issue.key, url), checkout, branch, commit);
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
  const searchRequests = [];
  await page.route("**/api/catalog", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), issueSearchEnabled: true } });
  });
  await page.route("**/api/issue-search", async (route) => {
    searchRequests.push({ method: route.request().method(), body: route.request().postDataJSON() });
    await route.fulfill({
      json: [
        { key: issue.key, title: issue.title, status: "open", assignee: null },
        { key: searchTarget.id, title: searchTargetTitle, status: "open", assignee: null },
      ],
    });
  });
  await Promise.all([page.waitForResponse("**/api/catalog"), page.goto(`${origin}/?issue=${issue.key}`)]);
  await page.getByRole("button", { name: "浏览工单代码", exact: true }).waitFor();
  const searchOpener = page.getByRole("radio", { name: "工单", exact: true });
  const searchDialog = page.getByRole("dialog", { name: "查找相似工单" });
  const searchInput = searchDialog.getByRole("textbox", { name: "工单搜索词" });
  const firstResult = searchDialog.getByRole("link", { name: issue.title, exact: true });
  const secondResult = searchDialog.getByRole("link", { name: searchTargetTitle, exact: true });
  const isFocused = (locator) => locator.evaluate((element) => document.activeElement === element);
  await searchOpener.focus();
  await page.keyboard.press("Alt+k");
  assert.ok(await isFocused(searchInput), "Alt+K focuses the search field");
  await searchInput.fill(searchTargetTitle);
  for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
    assert.ok(
      await searchInput.evaluate((input, init) => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init })), ime),
      "composition Enter remains available to the IME",
    );
  }
  assert.deepEqual(searchRequests, []);
  await page.keyboard.press("Enter");
  await secondResult.waitFor();
  assert.ok(await isFocused(searchInput), "search results do not steal focus");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  assert.ok(await isFocused(firstResult), "ArrowDown from the search field focuses the first result");
  await page.keyboard.press("ArrowDown");
  assert.ok(await isFocused(secondResult), "ArrowDown advances to the next result");
  await page.keyboard.press("ArrowUp");
  assert.ok(await isFocused(firstResult), "ArrowUp returns to the previous result");
  await page.keyboard.press("ArrowUp");
  assert.ok(await isFocused(searchInput), "ArrowUp from the first result returns to the search field");
  await page.keyboard.press("ArrowUp");
  assert.ok(await isFocused(secondResult), "ArrowUp from the search field focuses the last result");
  await page.keyboard.press("Escape");
  await searchDialog.waitFor({ state: "hidden" });
  assert.ok(await isFocused(searchOpener), "Escape restores focus to the opener");
  const expectedSearch = { method: "POST", body: { query: searchTargetTitle } };
  assert.deepEqual(searchRequests, [expectedSearch]);
  await page.keyboard.press("Alt+k");
  await searchInput.fill(searchTargetTitle);
  await page.keyboard.press("Enter");
  await secondResult.waitFor();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await searchDialog.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: searchTargetTitle, exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("issue"), searchTarget.id);
  assert.ok(await isFocused(searchOpener), "opening a result restores focus to the surviving opener");
  assert.deepEqual(searchRequests, [expectedSearch, expectedSearch]);
  await page.unroute("**/api/catalog");
  await page.unroute("**/api/issue-search");
  await page.goto(`${origin}/?issue=${issue.key}`);
  await page.getByRole("button", { name: "浏览工单代码", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => performance.getEntriesByType("resource").some((entry) => /\/(monaco-|editor\.|CodeBrowser-|SettingsView-)/.test(entry.name))), false);
  const editOpener = page.getByRole("button", { name: "编辑工单", exact: true });
  const editOpenerElement = await editOpener.elementHandle();
  await editOpener.click();
  const issueEditor = page.getByRole("dialog", { name: "编辑工单", exact: true });
  const issueTitle = issueEditor.getByLabel("编辑工单标题", { exact: true });
  await issueTitle.fill("Unsaved native dialog draft");
  await editOpenerElement.evaluate((button) => button.focus());
  assert.equal(await issueTitle.evaluate((input) => input === document.activeElement), true);
  await page.mouse.click(4, 4);
  assert.equal(await issueTitle.inputValue(), "Unsaved native dialog draft");
  const assignee = issueEditor.getByRole("combobox", { name: "编辑工单处理人", exact: true });
  await assignee.click();
  await issueEditor.getByRole("listbox", { name: "编辑工单处理人", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await issueEditor.getByRole("listbox").waitFor({ state: "hidden" });
  assert.ok(await isFocused(assignee), "Escape closes only the assignee dropdown and restores its trigger");
  await page.keyboard.press("Enter");
  await issueEditor.getByRole("listbox", { name: "编辑工单处理人", exact: true }).getByRole("option").first().waitFor();
  await page.keyboard.press("Enter");
  const clearAssignee = issueEditor.getByRole("button", { name: "清除 编辑工单处理人", exact: true });
  await page.keyboard.press("Tab");
  assert.ok(await isFocused(clearAssignee), "Tab reaches the assignee clear button");
  await page.keyboard.press("Enter");
  assert.equal(await clearAssignee.count(), 0, "Enter activates the clear button instead of opening the dropdown");
  assert.equal(await issueEditor.getByRole("listbox").count(), 0);
  assert.ok(await isFocused(assignee), "clearing returns focus to the trigger");
  const cc = issueEditor.getByRole("combobox", { name: "编辑工单抄送人", exact: true });
  await cc.click();
  const ccFilter = issueEditor.getByRole("searchbox", { name: "搜索 编辑工单抄送人", exact: true });
  const ccList = issueEditor.getByRole("listbox", { name: "编辑工单抄送人", exact: true });
  assert.ok(await isFocused(ccFilter), "the searchable dropdown focuses its filter");
  const firstCc = ccList.getByRole("option").first();
  await firstCc.waitFor();
  assert.equal(await firstCc.getAttribute("aria-selected"), "false");
  for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
    const handled = await ccFilter.evaluate((input, init) => !input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init })), ime);
    assert.equal(handled, false, "composition Enter must remain available to the input method");
    assert.equal(await firstCc.getAttribute("aria-selected"), "false");
  }
  await page.keyboard.press("Enter");
  assert.equal(await firstCc.getAttribute("aria-selected"), "true", "ordinary Enter selects the highlighted option");
  await page.keyboard.press("Backspace");
  assert.equal(await firstCc.getAttribute("aria-selected"), "false");
  await page.keyboard.press("Escape");
  await ccList.waitFor({ state: "hidden" });
  assert.ok(await isFocused(cc), "Escape closes only the searchable dropdown and restores its trigger");
  assert.equal(await issueTitle.inputValue(), "Unsaved native dialog draft");
  const descriptionInput = issueEditor.getByRole("textbox", { name: "编辑工单描述", exact: true });
  const descriptionHeight = () => descriptionInput.evaluate((input) => input.clientHeight);
  await descriptionInput.fill("");
  const shortHeight = await descriptionHeight();
  await descriptionInput.fill("one\ntwo\nthree\nfour");
  const fourLineHeight = await descriptionHeight();
  assert.ok(fourLineHeight > shortHeight);
  await descriptionInput.fill("many lines\n".repeat(20));
  const cappedHeight = await descriptionHeight();
  assert.ok(cappedHeight > fourLineHeight);
  assert.ok(await descriptionInput.evaluate((input) => input.scrollHeight > input.clientHeight));
  await descriptionInput.fill("many lines\n".repeat(40));
  assert.equal(await descriptionHeight(), cappedHeight);
  await descriptionInput.fill("");
  assert.equal(await descriptionHeight(), shortHeight);
  const expandDescription = issueEditor.getByRole("button", { name: "放大编辑工单描述", exact: true });
  await expandDescription.click();
  const expandedDescription = page.getByRole("dialog", { name: "编辑描述", exact: true });
  const expandedInput = expandedDescription.getByLabel("放大描述编辑器", { exact: true });
  await expandedInput.waitFor();
  assert.equal(await expandedInput.evaluate((input) => input === document.activeElement), true);
  await page.keyboard.press("Escape");
  await expandedDescription.waitFor({ state: "hidden" });
  assert.equal(await expandDescription.evaluate((button) => button === document.activeElement), true);
  await page.keyboard.press("Escape");
  await issueEditor.waitFor({ state: "hidden" });
  assert.equal(await editOpener.evaluate((button) => button === document.activeElement), true);
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
    await httpPage.getByRole("button", { name: "关闭代码浏览器", exact: true }).click();
    assert.equal(await httpPage.evaluate(() => typeof crypto.randomUUID), "undefined");
    const text = "Browser plain HTTP message";
    await httpPage.getByRole("textbox", { name: "发送给 Agent", exact: true }).fill(text);
    const [sent] = await Promise.all([
      httpPage.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/agent-messages")),
      httpPage.getByRole("button", { name: "发送消息", exact: true }).click(),
    ]);
    assert.equal(sent.status(), 202);
    assert.match((await sent.request().allHeaders())["x-issue-pilot-message-id"], /^[0-9a-f]{32}$/);
    assert.equal(engine.messages.at(-1), text);
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

  const queryMetadata = {
    region: "cn-hangzhou",
    project: "fixture-project",
    logstore: "application-log",
    from: 1_700_000_000,
    to: 1_700_003_600,
    timezone: "Asia/Shanghai",
    queryMode: "query",
    order: "newest_first",
    pagination: "offset",
    returnedRows: 65,
    possiblyIncomplete: false,
  };
  const queryRecords = Array.from({ length: 65 }, (_, index) => ({
    id: index,
    message: `fixture log ${index}`,
    level: index % 2 ? "INFO" : "WARN",
    latency: index,
    details: { enabled: false, trace: "x".repeat(220) },
    source: "<img src=x onerror=alert(1)>",
  }));
  const queryText = JSON.stringify({ query: queryMetadata, records: queryRecords });
  publish({ type: "tool_execution_start", toolCallId: "query-table", toolName: "service_query", args: { capability: "sls", environment: "test", service: "browser" } });
  publish({
    type: "tool_execution_end",
    toolCallId: "query-table",
    toolName: "service_query",
    isError: false,
    result: { content: [{ type: "text", text: queryText }], details: { provider: "aliyun-sls-cli", ...queryMetadata } },
  });
  const queryCard = page.locator("details.agent-tool", { has: page.getByLabel("工具 sls test/browser", { exact: true }) });
  await queryCard.waitFor();
  assert.equal(await queryCard.locator("table, pre").count(), 0, "query results remain lazy while collapsed");
  await queryCard.locator("summary").click();
  await queryCard.getByRole("table").waitFor();
  assert.equal(await queryCard.locator("tbody tr").count(), 50);
  assert.equal(await queryCard.locator("img").count(), 0);
  await queryCard.getByRole("button", { name: "按 id 升序排列", exact: true }).focus();
  await page.keyboard.press("Enter");
  await queryCard.locator('th[aria-sort="ascending"]').waitFor();
  await page.keyboard.press("Enter");
  await queryCard.locator('th[aria-sort="descending"]').waitFor();
  assert.equal(await queryCard.locator("tbody tr").first().locator("td").nth(1).textContent(), "64");
  await page.keyboard.press("Enter");
  await queryCard.locator("th[aria-sort]").waitFor({ state: "detached" });
  await queryCard.getByRole("button", { name: "下一页", exact: true }).click();
  await queryCard.getByText("51–65 / 65 条", { exact: true }).waitFor();
  assert.equal(await queryCard.locator("tbody tr").count(), 15);
  await queryCard.getByRole("textbox", { name: "筛选本次查询结果" }).fill("wArN");
  await queryCard.getByText("1–33 / 33 条", { exact: true }).waitFor();
  await queryCard.getByRole("radio", { name: "原文", exact: true }).click();
  await queryCard.locator("pre").waitFor();
  assert.equal(await queryCard.locator("pre").textContent(), queryText);
  await page.keyboard.press("ArrowLeft");
  await queryCard.getByRole("table").waitFor();
  assert.equal(await queryCard.getByRole("textbox").inputValue(), "wArN");
  await queryCard.getByRole("button", { name: "复制筛选结果", exact: true }).click();
  await queryCard.getByText("已复制筛选结果（33 条）", { exact: true }).waitFor();
  assert.deepEqual(
    JSON.parse(await page.evaluate(() => navigator.clipboard.readText())),
    queryRecords.filter((row) => row.level === "WARN"),
  );
  const recordOpener = queryCard.getByRole("button", { name: "查看第 1 条记录", exact: true });
  await recordOpener.click();
  const recordDialog = page.getByRole("dialog", { name: "查询记录 · 第 1 条", exact: true });
  await recordDialog.waitFor();
  assert.ok((await recordDialog.innerText()).includes("x".repeat(220)), "record details retain the entire long field");
  const browserClipboard = await page.evaluateHandle(() => navigator.clipboard);
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
  try {
    await recordDialog.getByRole("button", { name: "复制字段 details", exact: true }).click();
    await recordDialog.getByText("已复制字段 details", { exact: true }).waitFor();
    assert.deepEqual(JSON.parse(await browserClipboard.evaluate((clipboard) => clipboard.readText())), queryRecords[0].details);
  } finally {
    await page.evaluate((clipboard) => Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard }), browserClipboard);
    await browserClipboard.dispose();
  }
  const abortRequests = [];
  const trackAbort = (request) => {
    if (request.method() === "POST" && request.url().endsWith(`/api/issues/${issue.key}/abort`)) abortRequests.push(request.url());
  };
  page.on("request", trackAbort);
  engine.running.add(issue.id);
  publish({ type: "issue_run_state", state: "running" });
  await page.getByTitle("中断当前处理并取消后续排队，保留未发送草稿", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  assert.deepEqual(abortRequests, [], "Escape in a record dialog must not abort the active Agent");
  await recordDialog.waitFor({ state: "hidden" });
  assert.ok(await isFocused(recordOpener), "record dialog restores focus to the original row");
  page.off("request", trackAbort);
  engine.running.delete(issue.id);
  publish({ type: "issue_run_state", state: "idle" });
  await page.getByTitle("中断当前处理并取消后续排队，保留未发送草稿", { exact: true }).waitFor({ state: "hidden" });
  for (const width of [1680, 980, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const bounds = await queryCard.evaluate((element) => {
      const scroll = element.querySelector(".agent-query-scroll");
      return { right: element.getBoundingClientRect().right, width: element.clientWidth, content: element.scrollWidth, scrollHeight: scroll.clientHeight };
    });
    assert.ok(bounds.right <= width && bounds.content <= bounds.width && bounds.scrollHeight <= 360, `Query table overflows at ${width}px: ${JSON.stringify(bounds)}`);
    if (width === 390) {
      await queryCard.getByRole("textbox", { name: "筛选本次查询结果" }).fill("fixture log 64");
      await queryCard.getByText("1–1 / 1 条", { exact: true }).waitFor();
      await queryCard.getByRole("radio", { name: "原文", exact: true }).click();
      await queryCard.locator("pre").waitFor();
      await queryCard.getByRole("radio", { name: "表格", exact: true }).click();
      await queryCard.getByRole("textbox").fill("wArN");
      await queryCard.getByText("1–33 / 33 条", { exact: true }).waitFor();
      await recordOpener.click();
      await recordDialog.waitFor();
      const recordBounds = await recordDialog.boundingBox();
      assert.ok(recordBounds.x >= 0 && recordBounds.x + recordBounds.width <= width);
      await recordDialog.getByRole("button", { name: "关闭", exact: true }).click();
      await recordDialog.waitFor({ state: "hidden" });
    }
    if (process.env.ISSUE_PILOT_BROWSER_ARTIFACTS) {
      await mkdir(process.env.ISSUE_PILOT_BROWSER_ARTIFACTS, { recursive: true });
      await queryCard.locator("summary").scrollIntoViewIfNeeded();
      await page.locator(".agent-panel").screenshot({ path: path.join(process.env.ISSUE_PILOT_BROWSER_ARTIFACTS, `query-result-${width}.png`) });
    }
  }
  const queryScroll = queryCard.getByRole("region", { name: "查询结果表格，可滚动" });
  await queryScroll.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector(".agent-query-scroll").scrollLeft > 0);
  await queryCard.locator("summary").click();
  await queryCard.getByRole("table").waitFor({ state: "detached" });
  await page.setViewportSize({ width: 1680, height: 1050 });
  await page.locator(".agent-scroll").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });

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
  await assertHiddenScrollbar(parametersPanel);
  const lastParameter = parameters.getByRole("combobox", { name: "工单搜索" });
  for (const viewport of [settingsViewport, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    const savePosition = await saveParameters.boundingBox();
    // The number of fields can grow; keep scrolling in the form and the save action fixed.
    if (viewport === settingsViewport || (await parameters.evaluate((node) => node.scrollHeight > node.clientHeight))) await scrollToEnd(parameters, false);
    await assertPanelFixed(parametersPanel);
    assert.deepEqual(await saveParameters.boundingBox(), savePosition);
    const formBounds = await parameters.boundingBox();
    const lastParameterBounds = await lastParameter.boundingBox();
    assert.ok(lastParameterBounds.y >= formBounds.y && lastParameterBounds.y + lastParameterBounds.height <= formBounds.y + formBounds.height + 1);
  }
  const networkMode = parameters.getByRole("combobox", { name: "工单网络访问" });
  assert.equal(await networkMode.textContent(), "开放网络");
  assert.equal(await parameters.getByRole("textbox", { name: "Agent 网络基础白名单" }).count(), 0);

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
  // One real SSE lifecycle updates the conversation, queue and details; navigation shares the list.
  const synchronization = openDatabase(databaseFile);
  try {
    await synchronization.db.update(issues).set({ assigneeSubject: issuePilotConfig.bootstrapUser.subject, status: "pending", resolvedAt: null }).where(eq(issues.id, issue.id));
    const [related] = await synchronization.db.select().from(issues).where(eq(issues.title, "Home scroll fixture 1"));
    await synchronization.db.update(issues).set({ assigneeSubject: issuePilotConfig.bootstrapUser.subject, status: "pending", resolvedAt: null }).where(eq(issues.id, related.id));
    await synchronization.db.insert(issueRelations).values({ issueId: issue.id, relatedIssueId: related.id });
    await page.setViewportSize({ width: 1680, height: 1050 });
    await page.goto(`${origin}/?issue=${issue.key}`);
    await page.getByRole("button", { name: "编辑工单", exact: true }).waitFor();
    await page.getByText("正在加载对话…", { exact: true }).waitFor({ state: "hidden" });
    engine.running.add(issue.id);
    publish({ type: "issue_run_state", state: "running" });
    await page.getByTitle("中断当前处理并取消后续排队，保留未发送草稿", { exact: true }).waitFor();
    await page.getByRole("button", { name: "编辑工单", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "编辑工单", exact: true });
    await page.waitForFunction((button) => button.disabled, await edit.getByRole("button", { name: "重置", exact: true }).elementHandle());
    await edit.getByRole("button", { name: "取消", exact: true }).click();
    publish({ type: "issue_status", status: "complete" });
    // Business completion still leaves cleanup activity in the authoritative execution state.
    await page.getByTitle("中断当前处理并取消后续排队，保留未发送草稿", { exact: true }).waitFor();
    const synchronizedTitle = "Synchronized browser Issue";
    await synchronization.db.update(issues).set({ title: synchronizedTitle, updatedAt: new Date() }).where(eq(issues.id, issue.id));
    engine.running.delete(issue.id);
    publish({ type: "issue_run_state", state: "idle" });
    await page.getByTitle("中断当前处理并取消后续排队，保留未发送草稿", { exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("heading", { name: synchronizedTitle, exact: true }).waitFor();
    await page.getByLabel("工单队列", { exact: true }).getByText(synchronizedTitle, { exact: true }).waitFor();
    await page.getByRole("button", { name: "编辑工单", exact: true }).click();
    await page.waitForFunction((button) => !button.disabled, await edit.getByRole("button", { name: "重置", exact: true }).elementHandle());
    await edit.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("radio", { name: "首页", exact: true }).click();
    await page.getByRole("list", { name: "待处理工单", exact: true }).getByText(synchronizedTitle, { exact: true }).waitFor();
    await synchronization.db.update(issues).set({ description: "Description changed while viewing the homepage", updatedAt: new Date() }).where(eq(issues.id, issue.id));
    await page.getByRole("radio", { name: "工单", exact: true }).click();
    await page.getByText("Description changed while viewing the homepage", { exact: true }).waitFor();
    // Changing only the related Issue must invalidate the embedded card, even with an open editor.
    const queue = page.getByLabel("工单队列", { exact: true });
    await queue.getByText(related.title, { exact: true }).click();
    await page.getByRole("heading", { name: related.title, exact: true }).waitFor();
    await queue.getByText(synchronizedTitle, { exact: true }).click();
    await page.getByRole("heading", { name: synchronizedTitle, exact: true }).waitFor();
    await page.getByLabel("按状态筛选", { exact: true }).click();
    await page.getByRole("option", { name: "未解决", exact: true }).click();
    await page.getByLabel("发送给 Agent", { exact: true }).fill("Preserve this linked-view draft");
    await page.getByRole("button", { name: "编辑工单", exact: true }).click();
    await edit.getByLabel("编辑工单标题", { exact: true }).fill("Unsaved linked-view title");
    const dialogs = [];
    const dismissNavigation = async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    };
    page.on("dialog", dismissNavigation);
    await synchronization.db.update(issues).set({ title: "Related renamed externally", status: "resolved", resolvedAt: new Date(), updatedAt: new Date() }).where(eq(issues.id, related.id));
    const card = page.getByRole("link", { name: `打开关联工单 ${related.key}`, exact: true });
    await page.waitForFunction((key) => document.querySelector(`[aria-label="打开关联工单 ${key}"]`)?.title === "Related renamed externally", related.key);
    await card.getByText("已解决", { exact: true }).waitFor();
    assert.equal(await edit.getByLabel("编辑工单标题", { exact: true }).inputValue(), "Unsaved linked-view title");
    // The current Issue can leave the filter without background navigation or a discard prompt.
    await synchronization.db.update(issues).set({ status: "resolved", resolvedAt: new Date(), updatedAt: new Date() }).where(eq(issues.id, issue.id));
    await queue.getByText(synchronizedTitle, { exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("heading", { name: synchronizedTitle, exact: true }).waitFor();
    assert.equal(await edit.getByLabel("编辑工单标题", { exact: true }).inputValue(), "Unsaved linked-view title");
    assert.equal(await page.getByLabel("发送给 Agent", { exact: true }).inputValue(), "Preserve this linked-view draft");
    assert.deepEqual(dialogs, []);
    page.off("dialog", dismissNavigation);
    await edit.getByRole("button", { name: "取消", exact: true }).click();
  } finally {
    synchronization.close();
  }
  // Real JSONL + HTTP reads + live SSE, then a fresh replay. No cloud query or result-file fixture.
  const evidenceIssue = await createIssue(app, "browser", "dev", "Stored query evidence");
  const evidenceId = engine.enqueued.at(-1);
  const evidenceRoot = issueRoot(root, evidenceIssue.id);
  const evidenceSession = await createPrivateSessionManager(evidenceRoot, evidenceRoot);
  const evidenceDatabase = openDatabase(databaseFile);
  try {
    await evidenceDatabase.db.insert(agentSessions).values({ issueId: evidenceId, sessionFile: evidenceSession.getSessionFile(), workspacePath: evidenceRoot });
  } finally {
    evidenceDatabase.close();
  }
  engine.running.clear();
  await page.goto(`${origin}/?issue=${evidenceIssue.id}`);
  // Wait for the stream snapshot before publishing a live child result.
  await page.getByText("还没有对话", { exact: true }).waitFor();
  const completeRows = Array.from({ length: 70 }, (_, id) => ({ id, message: `complete row ${id} ${"evidence ".repeat(90)}` }));
  const completeText = JSON.stringify({ query: { ...queryMetadata, returnedRows: completeRows.length }, records: completeRows });
  const nestedQuery = persistNestedQuery(evidenceSession, {
    type: "tool_execution_end",
    toolName: "service_query",
    toolCallId: "script/1",
    parentToolCallId: "script",
    isError: false,
    result: { content: [{ type: "text", text: completeText }], details: { provider: "aliyun-sls-cli", environment: "test", service: "browser" } },
  });
  events.publish({ id: randomUUID(), issueId: evidenceId, createdAt: new Date().toISOString(), event: nestedQuery });
  const savedCard = page.locator("details.agent-tool", { has: page.getByLabel("工具 sls test/browser", { exact: true }) });
  const fullReads = [];
  page.on("request", (request) => {
    if (request.url().includes("/query-results/")) fullReads.push(request.url());
  });
  await savedCard.waitFor();
  assert.equal(await savedCard.getByText("子查询", { exact: true }).count(), 1);
  await savedCard.locator("summary").click();
  assert.equal(fullReads.length, 0);
  await savedCard.getByRole("button", { name: "查看完整结果", exact: true }).click();
  await savedCard.getByRole("table").waitFor();
  assert.equal(await savedCard.locator("tbody tr").count(), 50);
  await savedCard.getByRole("button", { name: "下一页", exact: true }).click();
  await savedCard.getByText("51–70 / 70 条", { exact: true }).waitFor();
  await savedCard.getByRole("radio", { name: "原文", exact: true }).click();
  assert.equal(await savedCard.locator("pre").textContent(), completeText);
  assert.equal(fullReads.length, 1);

  const dmsText = JSON.stringify({ tool: "executeScript", result: { content: [{ type: "text", text: "| id | state |\n| --- | --- |\n| 7 | ready |" }] } });
  const dmsEntry = evidenceSession.appendMessage({
    role: "toolResult",
    toolName: "service_query",
    toolCallId: "dms",
    isError: false,
    timestamp: Date.now(),
    content: [{ type: "text", text: dmsText }],
    details: { provider: "aliyun-dms-mcp", environment: "test", service: "browser", schema: "orders" },
  });
  events.publish({ id: randomUUID(), issueId: evidenceId, createdAt: new Date().toISOString(), event: savedQueryCompletion(evidenceSession.getSessionId(), evidenceSession.getEntry(dmsEntry)) });
  const dmsCard = page.locator("details.agent-tool", { has: page.getByLabel("工具 dms test/browser", { exact: true }) });
  await dmsCard.locator("summary").click();
  await dmsCard.getByRole("cell", { name: "ready", exact: true }).waitFor();
  await page.reload();
  await savedCard.locator("summary").click();
  await savedCard.getByRole("button", { name: "查看完整结果", exact: true }).click();
  await savedCard.getByRole("table").waitFor();
  assert.equal(await savedCard.locator("tbody tr").count(), 50);
  assert.equal(fullReads.length, 2);
  await dmsCard.locator("summary").click();
  await dmsCard.getByRole("cell", { name: "ready", exact: true }).waitFor();

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
          "search keyboard navigation, focus restoration, IME guards and one POST per explicit search",
          "Select preserves IME Enter, supports keyboard clearing and dismisses only its dropdown inside a native modal",
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
          "SLS result table mounts lazily, filters/pages locally, preserves raw text and scrolls by keyboard without narrow-screen overflow",
          "query sorting, complete filtered JSON copy and long-field details preserve data; modal fallback copy, Escape and focus work without aborting the Agent",
          "nested native evidence persists in JSONL, reads complete results on demand and survives reload; DMS Markdown tables render live and on replay",
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
          "SSE running/cleanup/idle synchronizes conversation controls and detail actions",
          "metadata refresh updates the queue and homepage without changing business status",
          "returning from the homepage reloads the same selected Issue details",
          "related Issue changes update embedded cards while retaining an open editor",
          "background filter exclusion preserves the selected Issue, editor and Agent draft without navigation prompts",
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
