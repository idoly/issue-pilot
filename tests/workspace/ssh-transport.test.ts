import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs, { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { environments, issueRepositories, issues, serviceDeployments, services } from "../../src/db/schema.ts";
import { createPersonalGitEnvironment, type PersonalGitEnvironment } from "../../src/workspace/git-credentials.ts";
import { shellQuote } from "../../src/agent/issue-sandbox.ts";
import { WorktreeManager } from "../../src/workspace/git.ts";
import { IssueProjectManager } from "../../src/workspace/project.ts";

const exec = promisify(execFile);

test("bound Git push uses personal SSH and preserves target refs, rejecting other identities and unknown hosts", async (context) => {
  const sshd = process.env.ISSUE_PILOT_TEST_SSHD ?? "/usr/sbin/sshd";
  try {
    await access(sshd);
  } catch (error) {
    if (process.env.ISSUE_PILOT_TEST_SSHD) throw error;
    context.skip("openssh-server unavailable; run npm run test:ssh for the isolated fixture");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-ssh-transport-"));
  const identities: PersonalGitEnvironment[] = [];
  let daemon: ReturnType<typeof spawn> | undefined;
  let database: Awaited<ReturnType<typeof openApplicationDatabase>> | undefined;
  try {
    for (const name of ["host", "personal", "other"]) await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(root, name)]);
    const authorized = path.join(root, "authorized_keys");
    await writeFile(authorized, await readFile(path.join(root, "personal.pub")), { mode: 0o600 });
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.2", resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
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
    await exec("git", ["-C", local, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
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
    const own = await manager.withGitEnvironment(correct.env, () => manager.prepare({ issueKey: key, workspaceName: "repo", url, baseBranch: "main", mode: "feature" }));
    const runtimeRoot = path.dirname(own.workspacePath);
    const branch = `refs/heads/${own.workingBranch}`;
    const tip = async (ref: string) => (await exec("git", ["-C", source, "rev-parse", "--verify", ref])).stdout.trim();
    await exec("git", ["-C", own.workspacePath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "issue change"]);
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
    for (const scenario of ["personal", "other", "untrusted"] as const) {
      if (scenario === "untrusted") knownHost = "";
      const privateKey = await readFile(path.join(root, scenario === "other" ? "other" : "personal"), "utf8");
      const identity = await createPersonalGitEnvironment({ gitPrivateKey: privateKey }, [url]);
      identities.push(identity);
      const workspace = await createWorkspaceTool(database.db, issue!, "dev", new IssueProjectManager(database.db, state), {
        stateRoot: state,
        runtimeRoot,
        personalGit: identity,
        commitEnvironment: {},
        networkDomains: [`127.0.0.2:${port}`],
      });
      const push = () => workspace.execute("ssh", { operation: "push", repository: "repo" }, undefined, undefined, {} as never);
      if (scenario === "personal") {
        await push();
        await exec("git", ["-C", own.workspacePath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "another change"]);
      } else {
        await assert.rejects(push(), scenario === "other" ? /Permission denied/ : /Host key verification failed/);
      }
      assert.equal(await tip(branch), first);
      assert.equal(await tip("refs/heads/main"), own.baseCommit);
      assert.equal(await tip("refs/heads/test"), own.baseCommit);
    }
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
