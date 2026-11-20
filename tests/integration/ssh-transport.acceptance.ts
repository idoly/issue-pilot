import assert from "node:assert/strict";
import { git } from "../helpers/git.ts";
import { execFile, spawn } from "node:child_process";
import fs, { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { once } from "node:events";
import { eq } from "drizzle-orm";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { createWorkspaceTool } from "../../src/agent/workspace-tool.ts";
import { issueNativeTools } from "../../src/agent/native-tools.ts";
import { gitIdentityEnvironment } from "../../src/agent/pi-session.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { environments, issueRepositories, issues, serviceDeployments, services } from "../../src/db/schema.ts";
import { createPersonalGitEnvironment, type PersonalGitEnvironment } from "../../src/workspace/git-credentials.ts";
import { shellQuote } from "../../src/agent/issue-sandbox.ts";
import { claimIssueRoot } from "../../src/workspace/state.ts";
import { WorktreeManager } from "../../src/workspace/git.ts";
import { IssueProjectManager } from "../../src/workspace/project.ts";

const exec = promisify(execFile);

test("bound Git push, same-branch sync and reviewed merges use personal SSH and preserve other refs", async (context) => {
  const sshd = process.env.ISSUE_PILOT_TEST_SSHD;
  if (!sshd) throw new Error("SSH fixture required; run npm run test:ssh");
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-ssh-transport-"));
  const identities: PersonalGitEnvironment[] = [];
  let daemon: ReturnType<typeof spawn> | undefined;
  let database: Awaited<ReturnType<typeof openApplicationDatabase>> | undefined;
  try {
    for (const name of ["host", "personal", "other"]) await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(root, name)]);
    const authorized = path.join(root, "authorized_keys");
    await writeFile(authorized, await readFile(path.join(root, "personal.pub")), { mode: 0o600 });
    const reservation = createServer();
    await new Promise<void>((resolve) => {
      reservation.listen(0, "127.0.0.2", resolve);
    });
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => {
      reservation.close(() => resolve());
    });
    const config = path.join(root, "sshd_config");
    await writeFile(
      config,
      `ListenAddress 127.0.0.2\nPort ${port}\nHostKey ${root}/host\nPidFile ${root}/sshd.pid\nAuthorizedKeysFile ${authorized}\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nSetEnv PATH=/opt/git/bin:/usr/local/bin:/usr/bin:/bin\nLogLevel VERBOSE\n`,
    );
    daemon = spawn(sshd, ["-D", "-e", "-f", config], { stdio: ["ignore", "ignore", "pipe"] });
    let logs = "";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sshd_fixture_start_timeout: ${logs}`)), 5000);
      daemon!.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      daemon!.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`sshd_fixture_exited: ${logs}`));
      });
      daemon!.stderr!.on("data", (chunk) => {
        logs += chunk.toString();
        if (logs.includes("Server listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const source = path.join(root, "source");
    await exec("git", ["init", "--bare", source]);
    const local = path.join(root, "local");
    await exec("git", ["init", "-b", "main", local]);
    await writeFile(path.join(local, "file.txt"), "SSH transport fixture");
    await exec("git", ["-C", local, "add", "."]);
    await git(["-C", local, "commit", "-m", "fixture"]);
    await exec("git", ["-C", source, "fetch", local, "refs/heads/main:refs/heads/main", "refs/heads/main:refs/heads/test"]);
    const originalRead = fs.readFile;
    let knownHost = `[127.0.0.2]:${port} ${(await readFile(path.join(root, "host.pub"), "utf8")).trim()}\n`;
    context.mock.method(fs, "readFile", (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === path.join(homedir(), ".ssh/known_hosts")) return Promise.resolve(knownHost);
      if (args[0] === path.join(homedir(), ".ssh/known_hosts2")) return Promise.resolve("");
      return originalRead(...args);
    });
    syncBuiltinESMExports();
    const url = `ssh://${userInfo().username}@127.0.0.2:${port}${source}`;
    const state = path.join(root, "state"),
      key = "ISSUE-20261112-001";
    const manager = new WorktreeManager(state);
    const correct = await createPersonalGitEnvironment({ gitPrivateKey: await readFile(path.join(root, "personal"), "utf8") }, [url]);
    identities.push(correct);
    await claimIssueRoot(state, key);
    const own = await manager.withGitEnvironment(correct.env, () => manager.prepare({ issueKey: key, workspaceName: "repo", url, baseBranch: "main", mode: "feature" }));
    const runtimeRoot = path.dirname(own.workspacePath);
    const branch = `refs/heads/${own.workingBranch}`;
    const tip = async (ref: string) => (await exec("git", ["-C", source, "rev-parse", "--verify", ref])).stdout.trim();
    await git(["-C", own.workspacePath, "commit", "--allow-empty", "-m", "issue change"]);
    const first = (await exec("git", ["-C", own.workspacePath, "rev-parse", "HEAD"])).stdout.trim();
    database = await openApplicationDatabase(path.join(state, "issues.db"));
    const [environment] = await database.db.select().from(environments).where(eq(environments.key, "dev"));
    const [service] = await database.db.insert(services).values({ key: "ssh-fixture", name: "SSH fixture" }).returning();
    await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment!.id, config: {} });
    const [issue] = await database.db
      .insert(issues)
      .values({
        key,
        title: "SSH fixture",
        type: "feature_development",
        serviceId: service!.id,
        environmentId: environment!.id,
        reporterSubject: issuePilotConfig.bootstrapUser.subject,
      })
      .returning();
    await database.db
      .insert(issueRepositories)
      .values({ issueId: issue!.id, url, baseBranch: "main", workingBranch: own.workingBranch, localPath: own.workspacePath, workspaceName: "repo", commitBefore: own.baseCommit });
    const bash = issueNativeTools({ writeRoot: runtimeRoot, stateRoot: state }).find((tool) => tool.name === "bash")!;
    const result = await bash.execute(
      "ssh",
      { command: `test ! -r ${shellQuote(path.join(correct.readRoots![0]!, "identity"))} && test -z "$ISSUE_PILOT_PERSONAL_GIT_SSH"` },
      undefined,
      undefined,
      {} as never,
    );
    const data = result.structuredContent;
    assert.ok(data && typeof data === "object" && "exit_code" in data);
    assert.equal(data.exit_code, 0, JSON.stringify(result));
    const workspaceFor = (identity: PersonalGitEnvironment) =>
      createWorkspaceTool(database!.db, issue!, "dev", new IssueProjectManager(database!.db, state), {
        stateRoot: state,
        runtimeRoot,
        personalGit: identity,
        commitEnvironment: gitIdentityEnvironment({ name: "Fixture developer", email: "fixture@example.test" }),
        networkDomains: [`127.0.0.2:${port}`],
      });
    for (const scenario of ["personal", "other", "untrusted"] as const) {
      if (scenario === "untrusted") knownHost = "";
      const privateKey = await readFile(path.join(root, scenario === "other" ? "other" : "personal"), "utf8");
      const identity = await createPersonalGitEnvironment({ gitPrivateKey: privateKey }, [url]);
      identities.push(identity);
      const workspace = await workspaceFor(identity);
      const push = () => workspace.execute("ssh", { operation: "push", repository: "repo" }, undefined, undefined, {} as never);
      if (scenario === "personal") {
        await assert.rejects(workspace.execute("ssh", { operation: "sync", repository: "repo" }, undefined, undefined, {} as never), /workspace_git_sync_failed/);
        await push();
        await git(["-C", own.workspacePath, "commit", "--allow-empty", "-m", "another change"]);
      } else {
        const reason = scenario === "other" ? /Permission denied/ : /Host key verification failed/;
        await assert.rejects(push(), reason);
        await assert.rejects(workspace.execute("ssh", { operation: "sync", repository: "repo" }, undefined, undefined, {} as never), reason);
      }
      assert.equal(await tip(branch), first);
      assert.equal(await tip("refs/heads/main"), own.baseCommit);
      assert.equal(await tip("refs/heads/test"), own.baseCommit);
    }
    const tool = await workspaceFor(correct);
    const call = async (operation: string, extra: Record<string, unknown> = {}) =>
      (await tool.execute("git", { operation, repository: "repo", ...extra }, undefined, undefined, {} as never)).structuredContent as Record<string, unknown>;
    const head = () => git(["-C", own.workspacePath, "rev-parse", "HEAD"]);
    const advance = async (checkout: string, file: string, text: string) => {
      await writeFile(path.join(checkout, file), text);
      await git(["-C", checkout, "add", "--", file]);
      await git(["-C", checkout, "commit", "-m", text]);
      return git(["-C", checkout, "rev-parse", "HEAD"]);
    };
    const publishRemote = () => git(["-C", source, "fetch", local, `HEAD:${branch}`]);
    const expected = (comparison: Record<string, unknown>) => ({ localTip: comparison.localTip, remoteTip: comparison.remoteTip });
    const ahead = await call("sync");
    assert.equal(ahead.status, "ahead");
    assert.deepEqual(ahead.localOnly, [await head()]);
    await git(["-C", local, "fetch", own.workspacePath, branch]);
    await git(["-C", local, "switch", "-c", "remote-fixture", "FETCH_HEAD"]);
    const remoteOnly = await advance(local, "remote.txt", "remote-only");
    await publishRemote();
    const note = path.join(own.workspacePath, "untracked.txt");
    await writeFile(note, "must survive");
    const dirty = await call("sync");
    assert.equal(dirty.status, "dirty");
    assert.deepEqual(dirty.remoteOnly, [remoteOnly]);
    assert.equal(await head(), ahead.localTip);
    assert.equal(await readFile(note, "utf8"), "must survive");
    await rm(note);
    assert.equal((await call("sync")).status, "fast_forwarded");
    assert.equal(await head(), remoteOnly);
    assert.equal(await readFile(path.join(own.workspacePath, "remote.txt"), "utf8"), "remote-only");
    assert.equal((await call("sync")).status, "up_to_date");
    const localChange = await advance(own.workspacePath, "own.txt", "local-only");
    const r1 = await advance(local, "b.txt", "independent remote change");
    await publishRemote();
    const divergent = await call("sync");
    assert.equal(divergent.status, "diverged");
    assert.deepEqual(divergent.localOnly, [localChange]);
    assert.deepEqual(divergent.remoteOnly, [r1]);
    assert.equal(await head(), localChange);
    const r2 = await advance(local, "c.txt", "remote advanced again");
    await publishRemote();
    await assert.rejects(call("merge", expected(divergent)), /workspace_git_sync_tips_changed/);
    assert.equal(await head(), localChange);
    const reviewed = expected(await call("sync"));
    assert.equal((await call("merge", reviewed)).status, "ready_to_commit");
    assert.equal(await head(), localChange);
    assert.equal((await call("merge", reviewed)).status, "ready_to_commit");
    await assert.rejects(call("push"), /workspace_git_merge_in_progress/);
    await call("commit", { message: "合并已复核的远端改动" });
    assert.equal(await git(["-C", own.workspacePath, "show", "-s", "--format=%P", "HEAD"]), `${localChange} ${r2}`);
    await call("push");
    await git(["-C", local, "fetch", source, branch]);
    await git(["-C", local, "merge", "--ff-only", "FETCH_HEAD"]);
    await advance(own.workspacePath, "b.txt", "second local edit");
    await advance(local, "b.txt", "second remote edit");
    const a = await advance(own.workspacePath, "file.txt", "local edit");
    const b = await advance(local, "file.txt", "remote edit");
    await publishRemote();
    const merge = expected(await call("sync"));
    const conflict = await call("merge", merge);
    assert.equal(conflict.status, "conflicts");
    assert.deepEqual(conflict.conflictPaths, ["b.txt", "file.txt"]);
    assert.equal(await head(), a);
    assert.equal(await tip(branch), b);
    assert.equal((await call("sync")).status, "conflicts");
    await writeFile(path.join(own.workspacePath, "file.txt"), "local edit");
    await call("stage", { paths: ["file.txt"] });
    assert.deepEqual((await call("sync")).conflictPaths, ["b.txt"]);
    await writeFile(path.join(own.workspacePath, "b.txt"), "second local edit");
    await call("stage", { paths: ["b.txt"] });
    assert.equal((await call("sync")).status, "ready_to_commit");
    assert.equal(await git(["-C", own.workspacePath, "status", "--porcelain"]), "", "a pending second parent is state even without a file diff");
    await assert.rejects(manager.assertClean(url, own.workspacePath, own.workingBranch!), /workspace_has_changes/);
    await call("commit", { message: "保留双方提交并解决冲突" });
    await call("push");
    assert.equal(await tip(branch), await head());
    assert.equal(await git(["-C", source, "show", "-s", "--format=%P", branch]), `${a} ${b}`);
    assert.equal(await tip("refs/heads/main"), own.baseCommit);
    assert.equal(await tip("refs/heads/test"), own.baseCommit);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await database?.close();
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      const closed = once(daemon, "close");
      daemon.kill("SIGTERM");
      await closed;
    }
    await Promise.all(identities.map((identity) => identity.close()));
    await rm(root, { recursive: true, force: true });
  }
});
