import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { git } from "../helpers/git.ts";

const exec = promisify(execFile);
const release = path.resolve("scripts/host/release.sh");
const probe = path.resolve("scripts/host/health-probe.sh");
const runner = path.resolve("scripts/host/runner.py");
const checker = path.resolve("scripts/prune-web-assets.ts");

async function fixtureFile(root: string, name: string, text: string, mode = 0o644) {
  const file = path.join(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, { mode });
}

async function generation(checkout: string, id: string) {
  const web = "src/web/dist";
  const asset = `assets/index-${id}ABCDE.js`;
  await fixtureFile(checkout, `${web}/${asset}`, id);
  await fixtureFile(checkout, `${web}/.vite/manifest.json`, JSON.stringify({ "index.html": { file: asset } }));
  await fixtureFile(checkout, `${web}/index.html`, `<script src="/${asset}"></script>`);
}

test("release validates artifacts before stopping, then switches source and Web only after stop", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "issue-pilot-host-release-test-"));
  const live = path.join(sandbox, "live");
  const candidate = path.join(sandbox, "candidate");
  const trace = path.join(sandbox, "release-trace");
  const lock = path.join(sandbox, "operation.lock");
  const env = { ...process.env, NODE: process.execPath, PYTHON: "/usr/bin/python3", PATH: `${sandbox}:${process.env.PATH}` };
  try {
    await git(["init", "-b", "main", live]);
    await fixtureFile(live, ".gitignore", "/node_modules/\n/src/web/dist/\n/data/\n");
    await fixtureFile(live, "package.json", '{"type":"module"}');
    await fixtureFile(live, "drizzle/meta/_journal.json", '{"entries":[{"tag":"fixture","when":1}]}');
    await fixtureFile(live, "src/http/dependency-patches.ts", "export async function verifyRuntimeDependencyPatches() {}");
    await fixtureFile(live, "release-revision.txt", "old");
    await fixtureFile(
      live,
      "scripts/prune-web-assets.ts",
      `import { spawnSync } from "node:child_process"; process.exit(spawnSync(process.execPath, [${JSON.stringify(checker)}, ...process.argv.slice(2)], { stdio: "inherit" }).status ?? 1);`,
    );
    // This runner has no access to real processes. It records the on-disk source/page visible at every action.
    await fixtureFile(
      live,
      "scripts/host/runner.py",
      `
import argparse, fcntl, json, os, pathlib
p = argparse.ArgumentParser()
p.add_argument("--root", type=pathlib.Path, required=True)
p.add_argument("--node")
p.add_argument("--lock-fd", type=int)
p.add_argument("--revision")
p.add_argument("action")
a = p.parse_args()
root = a.root
web = root / "src/web/dist"
if a.action == "config":
    lock = ${JSON.stringify(lock)}
    if os.environ["TEST_RELEASE_MODE"] == "lock-changed" and (root / "release-revision.txt").read_text() == "new":
        lock += ".new"
    print(json.dumps(dict(baseUrl="http://127.0.0.1:1", host="127.0.0.1", stateRoot=str(root / "data"),
        databaseFile=str(root / "data/db.sqlite"), webRoot=str(web), operationLock=lock)))
elif a.action == "status":
    print("{}")
else:
    fcntl.flock(a.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    revision = (root / "release-revision.txt").read_text()
    page = web.joinpath("index.html").read_text()
    with open(${JSON.stringify(trace)}, "a") as events:
        runner_revision = (pathlib.Path(__file__).resolve().parents[2] / "release-revision.txt").read_text()
        print(a.action, revision, "new" if "newABCDE" in page else "old", "runner=" + runner_revision, file=events)
    mode = os.environ["TEST_RELEASE_MODE"]
    if a.action == "stop" and (mode == "stop-fails" or (mode == "start-fails" and revision == "new")):
        raise SystemExit(1)
    if a.action == "start" and mode == "start-fails":
        raise SystemExit(1)
`,
    );
    await fixtureFile(sandbox, "curl", "#!/bin/sh\nprintf '%s\\n' '{\"ok\":true}'\n", 0o755);
    await git(["-C", live, "add", "."]);
    await git(["-C", live, "commit", "-m", "fixture base"]);
    await git(["-C", live, "worktree", "add", "--detach", candidate, "HEAD"]);
    await fixtureFile(candidate, "release-revision.txt", "new");
    await git(["-C", candidate, "commit", "-am", "fixture candidate"]);
    const head = await git(["-C", candidate, "rev-parse", "HEAD"]);
    await mkdir(path.join(live, "data"));
    const db = new DatabaseSync(path.join(live, "data/db.sqlite"));
    db.exec("CREATE TABLE __drizzle_migrations (created_at INTEGER); INSERT INTO __drizzle_migrations VALUES (1);");
    db.close();
    for (const checkout of [live, candidate]) await mkdir(path.join(checkout, "node_modules"));
    await generation(live, "old");
    await generation(candidate, "new");
    const run = (mode: string) => exec("bash", [release, "--root", live, "--candidate", candidate, "--revision", head], { env: { ...env, TEST_RELEASE_MODE: mode, TMPDIR: sandbox } });

    await assert.rejects(run("lock-changed"), /Candidate changes the host operation lock/);
    await fixtureFile(candidate, "src/web/dist/index.html", '<script src="/assets/index-badABCDE.js"></script>');
    await assert.rejects(run("ok"), /web_manifest_html_mismatch/);
    await assert.rejects(readFile(trace), { code: "ENOENT" });
    await generation(candidate, "new");
    await assert.rejects(run("stop-fails"));
    assert.equal(await readFile(trace, "utf8"), "stop old old runner=old\n");
    assert.equal(await readFile(path.join(live, "release-revision.txt"), "utf8"), "old");

    await assert.rejects(run("start-fails"), /failed process did not stop/);
    assert.equal(await readFile(trace, "utf8"), "stop old old runner=old\nstop old old runner=old\nstart new new runner=new\nstop new new runner=new\n");
    assert.match(await readFile(path.join(live, "src/web/dist/index.html"), "utf8"), /newABCDE/);
    assert.match(await readFile(path.join(live, "src/web/dist/index.previous.html"), "utf8"), /oldABCDE/);

    assert.match((await run("ok")).stdout, /release complete/);
    assert.match(await readFile(path.join(live, "src/web/dist/index.previous.html"), "utf8"), /oldABCDE/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the health probe detects nine recent launches with only five rotated logs", async () => {
  if (process.getuid?.() === 0) return;
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-host-probe-test-"));
  try {
    const host = path.join(root, "issue-pilot-host");
    const now = Math.floor(Date.now() / 1000);
    await mkdir(host, { mode: 0o700 });
    await fixtureFile(root, "src/http/production.ts", "");
    await fixtureFile(
      root,
      "src/config.ts",
      `export const applicationConfig = ${JSON.stringify({
        stateRoot: root,
        databaseFile: path.join(root, "fake.db"),
        webRoot: root,
        http: { host: "127.0.0.1", port: 1 },
      })};`,
    );
    await fixtureFile(root, "scripts/host/runner.py", await readFile(runner, "utf8"));
    await fixtureFile(root, "curl", "#!/bin/sh\nprintf '%s\\n' '{\"ok\":true}'\n", 0o755);
    for (let i = 0; i < 5; i++) await fixtureFile(host, `application.${i}.log`, "fixture");
    await fixtureFile(host, "launches.json", JSON.stringify([now - 90_000, ...Array.from({ length: 9 }, (_, i) => now - i - 1)]), 0o600);
    const probeHost = (...options: string[]) =>
      exec("bash", [probe, "--root", root, "--min-free-mb", "0", "--min-available-mb", "0", ...options], {
        env: { ...process.env, NODE: process.execPath, PYTHON: "/usr/bin/python3", PATH: `${root}:${process.env.PATH}`, XDG_STATE_HOME: root },
      });
    await assert.rejects(probeHost(), (error: unknown) => error instanceof Error && "stdout" in error && /restarts_24h=9 .*status=breach failed=restarts_24h/.test(String(error.stdout)));
    assert.match((await probeHost("--max-restarts-24h", "9")).stdout, /restarts_24h=9 .*status=ok/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
