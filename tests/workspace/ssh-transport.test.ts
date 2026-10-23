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
import { issueNativeTools } from "../../src/agent/native-tools.ts";
import { createPersonalGitEnvironment, type PersonalGitEnvironment } from "../../src/workspace/git-credentials.ts";
import { shellQuote } from "../../src/agent/issue-sandbox.ts";

const exec = promisify(execFile);

test("personal SSH authenticates Git through SRT and rejects another identity and an unknown host", async context => {
  const sshd = process.env.ISSUE_PILOT_TEST_SSHD ?? "/usr/sbin/sshd";
  try { await access(sshd); } catch { context.skip("openssh-server fixture is verified in the container harness"); return; }
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-ssh-transport-"));
  const identities: PersonalGitEnvironment[] = [];
  let daemon: ReturnType<typeof spawn> | undefined;
  try {
    for (const name of ["host", "personal", "other"]) await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(root, name)]);
    const authorized = path.join(root, "authorized_keys");
    await writeFile(authorized, await readFile(path.join(root, "personal.pub")), { mode: 0o600 });
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, "127.0.0.2", resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const config = path.join(root, "sshd_config");
    await writeFile(config, `ListenAddress 127.0.0.2\nPort ${port}\nHostKey ${root}/host\nPidFile ${root}/sshd.pid\nAuthorizedKeysFile ${authorized}\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nSetEnv PATH=/opt/git/bin:/usr/local/bin:/usr/bin:/bin\nLogLevel VERBOSE\n`);
    daemon = spawn(sshd, ["-D", "-e", "-f", config], { stdio: ["ignore", "ignore", "pipe"] });
    let logs = "";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sshd_fixture_start_timeout: ${logs}`)), 5000);
      daemon!.once("error", error => { clearTimeout(timer); reject(error); });
      daemon!.once("exit", () => { clearTimeout(timer); reject(new Error(`sshd_fixture_exited: ${logs}`)); });
      daemon!.stderr!.on("data", chunk => { logs += chunk.toString(); if (logs.includes("Server listening")) { clearTimeout(timer); resolve(); } });
    });
    const source = path.join(root, "source");
    await exec("git", ["init", "--bare", source]);
    const local = path.join(root, "local");
    await exec("git", ["init", "-b", "main", local]);
    await writeFile(path.join(local, "file.txt"), "SSH transport fixture");
    await exec("git", ["-C", local, "add", "."]);
    await exec("git", ["-C", local, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
    const originalRead = fs.readFile;
    let knownHost = `[127.0.0.2]:${port} ${(await readFile(path.join(root, "host.pub"), "utf8")).trim()}\n`;
    context.mock.method(fs, "readFile", (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === path.join(homedir(), ".ssh/known_hosts")) return Promise.resolve(knownHost);
      if (args[0] === path.join(homedir(), ".ssh/known_hosts2")) return Promise.resolve("");
      return originalRead(...args);
    });
    syncBuiltinESMExports();
    const globalConfig = path.join(root, "gitconfig");
    await writeFile(globalConfig, "[credential]\n\thelper = fixture-helper\n[http]\n\textraHeader = fixture-header\n");
    const url = `ssh://${userInfo().username}@127.0.0.2:${port}${source}`;
    for (const scenario of ["personal", "other", "untrusted"] as const) {
      if (scenario === "untrusted") knownHost = "";
      const privateKey = await readFile(path.join(root, scenario === "other" ? "other" : "personal"), "utf8");
      const identity = await createPersonalGitEnvironment({ gitPrivateKey: privateKey }, [url]); identities.push(identity);
      const bash = issueNativeTools({ writeRoot: root, readRoots: identity.readRoots ?? [], networkDomains: [`127.0.0.2:${port}`] }, () => ({ ...identity.env, GIT_CONFIG_GLOBAL: globalConfig })).find(tool => tool.name === "bash")!;
      const result = await bash.execute("ssh", { command: `git config --get credential.helper >/dev/null && test "$(git config --get credential.helper)" = '' && git config --get http.extraHeader >/dev/null && test "$(git config --get http.extraHeader)" = '' && git config --get-all safe.directory | grep -Fx ${shellQuote(root)} >/dev/null && timeout 10 git -C local push ${shellQuote(url)} HEAD:refs/heads/ssh-fixture && timeout 10 git ls-remote ${shellQuote(url)}` }, undefined, undefined, {} as never);
      const data = result.structuredContent;
      assert.ok(data && typeof data === "object" && "exit_code" in data);
      if (scenario === "personal") assert.equal(data.exit_code, 0, JSON.stringify(result));
      else assert.notEqual(data.exit_code, 0, scenario);
    }
  } finally {
    context.mock.restoreAll(); syncBuiltinESMExports();
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) { const closed = once(daemon, "close"); daemon.kill("SIGTERM"); await closed; }
    await Promise.all(identities.map(identity => identity.close()));
    await rm(root, { recursive: true, force: true });
  }
});
