import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { createPrivateSessionManager } from "../../src/agent/pi-session.ts";
import { openDatabase } from "../../src/db/client.ts";
import { agentSessions, issueRepositories, issueWorkspaces, issues } from "../../src/db/schema.ts";
import { buildApi } from "../../src/http/api.ts";
import { issueRepositoryStorePath, repositoryStorePath } from "../../src/workspace/git.ts";
import { isolateIssueWorktree } from "../../src/workspace/issue-git.ts";
import { issueRoot } from "../../src/workspace/state.ts";
import { createService, createIssue, modelCatalog, TestAgentController } from "../http/fixture.ts";

// No production origin or state-path option: every run owns its temporary SQLite/Git/JSONL.
const { values } = parseArgs({ options: { runs: { type: "string", default: "3" }, profile: { type: "string", default: "all" }, compare: { type: "string" }, output: { type: "string" } } });
const runs = Number(values.runs);
assert.ok(Number.isSafeInteger(runs) && runs >= 1 && runs <= 20, "--runs must be 1..20");
assert.ok(["all", "local", "slow"].includes(values.profile), "--profile must be all, local or slow");
const profiles = {
  local: { latency: 0, downloadThroughput: -1, uploadThroughput: -1, cpu: 1 },
  slow: { latency: 150, downloadThroughput: (1.6 * 1_000_000) / 8, uploadThroughput: 750_000 / 8, cpu: 4 },
};
const exec = promisify(execFile);
const { chromium } = await import(process.env.ISSUE_PILOT_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.ISSUE_PILOT_PLAYWRIGHT_MODULE).href : "playwright");
const variants = [{ name: "current", webRoot: path.resolve(process.env.ISSUE_PILOT_BROWSER_WEB_ROOT ?? "src/web/dist") }];
if (values.compare) variants.unshift({ name: "baseline", webRoot: path.resolve(values.compare) });
const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-performance-"));
const fixtures = [];
const samples = [];
let browser;

async function inspectBuild(webRoot) {
  const digest = createHash("sha256");
  let compressedBytes = 0;
  let compressedFiles = 0;
  for (const file of (await readdir(path.join(webRoot, "assets"))).sort()) {
    if (!/\.(?:js|css)(?:\.br|\.gz)?$/.test(file)) continue;
    const bytes = await readFile(path.join(webRoot, "assets", file));
    digest.update(file).update("\0").update(bytes);
    if (/\.(?:br|gz)$/.test(file)) {
      const original = await readFile(path.join(webRoot, "assets", file.replace(/\.(?:br|gz)$/, "")));
      const decoded = file.endsWith(".br") ? brotliDecompressSync(bytes) : gunzipSync(bytes);
      assert.ok(decoded.equals(original), `Compressed build differs from original: ${file}`);
      compressedBytes += bytes.length;
      compressedFiles++;
    }
  }
  return {
    indexSha256: createHash("sha256")
      .update(await readFile(path.join(webRoot, "index.html")))
      .digest("hex"),
    assetsSha256: digest.digest("hex"),
    compressedFiles,
    compressedBytes,
  };
}

async function fixture(variant) {
  const build = await inspectBuild(variant.webRoot);
  const stateRoot = path.join(root, variant.name);
  await mkdir(stateRoot);
  const databaseFile = path.join(stateRoot, "issues.db");
  const engine = new TestAgentController();
  const app = await buildApi({ stateRoot, databaseFile, engine, modelCatalog, logger: false, webRoot: variant.webRoot });
  // Register immediately so a partially prepared fixture is still closed on failure.
  const result = { ...variant, app, build, issue: undefined, longIssue: undefined };
  fixtures.push(result);
  await createService(app, "performance", ["dev"]);
  const database = openDatabase(databaseFile);
  try {
    for (let index = 0; index < 30; index++) {
      const created = await createIssue(app, "performance", "dev", `Performance issue ${index}`);
      const [issue] = await database.db.select().from(issues).where(eq(issues.key, created.id));
      await database.db.update(issues).set({ assigneeSubject: issuePilotConfig.bootstrapUser.subject }).where(eq(issues.id, issue.id));
      if (index > 1) continue;
      const workspace = issueRoot(stateRoot, issue.key);
      const session = await createPrivateSessionManager(workspace, workspace);
      const turns = index === 0 ? 4 : 150;
      for (let turn = 0; turn < turns; turn++) {
        session.appendCustomEntry("issue-pilot-user", { message: `Investigate sample ${turn}` });
        session.appendMessage({
          role: "assistant",
          api: "openai-completions",
          provider: "enterprise-ai",
          model: "engineering-model",
          content: [{ type: "text", text: `### Finding ${turn}\n\n${"Synthetic evidence with **formatting** and `code`. ".repeat(20)}\n\nPerformance end ${index}-${turn}` }],
          usage: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 200, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: 1_700_000_000_000 + turn,
        });
      }
      await database.db.insert(agentSessions).values({ issueId: issue.id, sessionFile: session.getSessionFile(), workspacePath: workspace });
      const item = { ...issue, marker: `Performance end ${index}-${turns - 1}` };
      if (index === 0) result.issue = item;
      else result.longIssue = item;
    }
    const source = path.join(stateRoot, "seed");
    const url = "https://example.test/performance.git";
    await exec("git", ["init", "-b", "main", source]);
    await writeFile(path.join(source, "sample.json"), '{"message":"performance fixture","enabled":true}\n');
    await exec("git", ["-C", source, "add", "."]);
    await exec("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Fixture"]);
    const commit = (await exec("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
    const store = repositoryStorePath(stateRoot, url);
    await mkdir(path.dirname(store), { recursive: true });
    await exec("git", ["clone", "--bare", source, store]);
    await exec("git", ["-C", store, "remote", "set-url", "origin", url]);
    const checkout = path.join(issueRoot(stateRoot, result.issue.key), "application");
    await exec("git", ["--git-dir", store, "worktree", "add", "-b", "performance", checkout, "main"]);
    await isolateIssueWorktree(store, issueRepositoryStorePath(stateRoot, result.issue.key, url), checkout, "performance", commit);
    await database.db
      .insert(issueRepositories)
      .values({ issueId: result.issue.id, url, baseBranch: "main", workingBranch: "performance", localPath: checkout, workspaceName: "application", commitBefore: commit });
    await database.db.update(issueWorkspaces).set({ status: "ready", runtimeReady: true }).where(eq(issueWorkspaces.issueId, result.issue.id));
  } finally {
    database.close();
  }
  engine.running.clear();
  result.origin = await app.listen({ host: "127.0.0.1", port: 0 });
  return result;
}

// Browser-side timestamps avoid including Playwright polling / transport latency.
function observeReadiness() {
  const snapshots = new Map();
  const NativeEventSource = window.EventSource;
  window.EventSource = class extends NativeEventSource {
    constructor(url, options) {
      super(url, options);
      const streamPath = new URL(url, location.href).pathname;
      snapshots.delete(streamPath);
      this.addEventListener("snapshot_ready", () => snapshots.set(streamPath, performance.now()));
    }
  };
  const visible = (element) => {
    if (!element || !element.checkVisibility()) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
  };
  window.performanceScenario = (key, marker, start = performance.now()) => {
    const metrics = { start };
    snapshots.delete(`/api/issues/${key}/agent-stream`);
    const check = () => {
      const now = performance.now() - start;
      const panel = document.querySelector(`[aria-label="${key} Agent 会话"]`);
      if (metrics.listMs === undefined && Array.from(document.querySelectorAll(".queue-item")).some(visible)) metrics.listMs = now;
      if (metrics.detailMs === undefined && panel && visible(Array.from(document.querySelectorAll("button")).find((button) => button.textContent.trim() === "编辑工单"))) metrics.detailMs = now;
      const last = panel?.querySelector(".agent-message:last-child");
      const snapshot = snapshots.get(`/api/issues/${key}/agent-stream`);
      if (snapshot !== undefined) metrics.snapshotMs = snapshot - start;
      if (metrics.conversationMs === undefined && snapshots.has(`/api/issues/${key}/agent-stream`) && visible(last) && last.textContent.includes(marker)) metrics.conversationMs = now;
      if (Object.keys(metrics).length < 5) requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
    window.performanceSample = metrics;
  };
}

async function measure(fixture, profileName, round) {
  const context = await browser.newContext({ viewport: { width: 1680, height: 1050 }, serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(90_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    const { cpu, ...network } = profiles[profileName];
    await cdp.send("Network.emulateNetworkConditions", { offline: false, ...network });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
    await page.addInitScript(`(${observeReadiness.toString()})(); window.performanceScenario(${JSON.stringify(fixture.issue.key)}, ${JSON.stringify(fixture.issue.marker)}, 0);`);
    const collect = async (scenario) => {
      try {
        await page.waitForFunction(() => window.performanceSample?.conversationMs !== undefined && window.performanceSample?.detailMs !== undefined && window.performanceSample?.listMs !== undefined);
      } catch (cause) {
        throw new Error(`${scenario} readiness failed: ${JSON.stringify(await page.evaluate(() => window.performanceSample))}; ${errors.join("; ")}`, { cause });
      }
      const sample = await page.evaluate(() => {
        const { start, ...timings } = window.performanceSample;
        const resources = performance.getEntriesByType("resource").filter((entry) => entry.startTime >= start);
        return {
          ...timings,
          requests: resources.map((entry) => ({
            path: new URL(entry.name).pathname,
            startMs: entry.startTime - start,
            durationMs: entry.duration,
            transferBytes: entry.transferSize,
            bodyBytes: entry.encodedBodySize,
          })),
          jsRequests: resources.filter((entry) => new URL(entry.name).pathname.endsWith(".js")).length,
          transferBytes: resources.reduce((sum, entry) => sum + entry.transferSize, 0),
        };
      });
      assert.deepEqual(errors, []);
      samples.push({ variant: fixture.name, profile: profileName, round, scenario, ...sample });
      process.stderr.write(`${fixture.name} ${profileName} ${round} ${scenario}: ${Math.round(sample.conversationMs)} ms\n`);
      return sample;
    };
    await page.goto(`${fixture.origin}/?issue=${fixture.issue.key}`, { waitUntil: "commit" });
    await collect("cold");
    assert.equal(await page.evaluate(() => performance.getEntriesByType("resource").some((entry) => /\/(monaco-|editor\.|CodeBrowser-|SettingsView-)/.test(entry.name))), false);
    await page.reload({ waitUntil: "commit" });
    await collect("warm");
    await page.evaluate(({ key, marker }) => window.performanceScenario(key, marker), fixture.longIssue);
    await page.locator(".queue-item").filter({ hasText: fixture.longIssue.key }).click();
    await collect("long-navigation");
    await page.evaluate(({ key, marker }) => window.performanceScenario(key, marker), fixture.issue);
    await page.locator(".queue-item").filter({ hasText: fixture.issue.key }).click();
    await collect("return-navigation");
    const editorStart = await page.evaluate(() => performance.now());
    await page.getByRole("button", { name: "浏览工单代码", exact: true }).click();
    await page.getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("button", { name: "sample.json", exact: true }).click();
    await page.getByRole("textbox", { name: "代码内容 sample.json", exact: true }).waitFor();
    // Verify the editor has content and accepts interaction; no file is changed or saved.
    await page.getByRole("textbox", { name: "代码内容 sample.json", exact: true }).press("Control+Home");
    assert.match(await page.locator(".monaco-editor .view-lines").innerText(), /performance\sfixture/);
    const editorMs = await page.evaluate((start) => performance.now() - start, editorStart);
    assert.deepEqual(errors, []);
    samples.push({ variant: fixture.name, profile: profileName, round, scenario: "editor", editorMs });
  } finally {
    await context.close();
  }
}

function median(numbers) {
  const sorted = numbers.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

try {
  for (const variant of variants) await fixture(variant);
  browser = process.env.ISSUE_PILOT_BROWSER_WS ? await chromium.connect(process.env.ISSUE_PILOT_BROWSER_WS) : await chromium.launch({ headless: true });
  for (const profile of Object.keys(profiles).filter((name) => values.profile === "all" || name === values.profile)) {
    for (let round = 1; round <= runs; round++) {
      // AB / BA alternation limits order effects. Scenarios and browser contexts remain serial.
      for (const item of round % 2 ? fixtures : fixtures.toReversed()) await measure(item, profile, round);
    }
  }
  const summary = [];
  for (const sample of samples) {
    if (summary.some((entry) => entry.variant === sample.variant && entry.profile === sample.profile && entry.scenario === sample.scenario)) continue;
    const group = samples.filter((entry) => entry.variant === sample.variant && entry.profile === sample.profile && entry.scenario === sample.scenario);
    const metrics = Object.keys(sample).filter((key) => key.endsWith("Ms") || key.endsWith("Bytes") || key === "jsRequests");
    summary.push({
      variant: sample.variant,
      profile: sample.profile,
      scenario: sample.scenario,
      medians: Object.fromEntries(metrics.map((key) => [key, Math.round(median(group.map((entry) => entry[key])))])),
    });
  }
  const report = {
    revision: (await exec("git", ["rev-parse", "HEAD"])).stdout.trim(),
    sourceDiffSha256: createHash("sha256")
      .update((await exec("git", ["diff", "HEAD", "--", "src", "package.json", "issue-pilot.config.ts"])).stdout)
      .digest("hex"),
    runnerSha256: createHash("sha256")
      .update(await readFile(new URL(import.meta.url)))
      .digest("hex"),
    chromium: browser.version(),
    profiles,
    runs,
    fixtures: { issues: 30, shortTurns: 4, longTurns: 150 },
    builds: fixtures.map(({ name, build }) => ({ name, ...build })),
    notes:
      "Local laboratory only; server warm, fresh browser context per run, warm reload retains HTTP cache. Resource timings exclude unfinished SSE and navigation HTML; conversation readiness includes snapshot and visible final message. Editor timing includes scripted interaction. No absolute performance gate.",
    summary,
    samples,
  };
  if (values.output) await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      for (const item of fixtures) await item.app.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
