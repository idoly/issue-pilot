import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { issueCodeServerUrl } from "../../src/workspace/code-server.ts";

const exec = promisify(execFile);
const directories: string[] = [];
const sourceScript = resolve("infra/code-server.sh");
const sourceConfig = resolve("issue-pilot.config.ts");
const sourceConfigReader = resolve("infra/config-value.mjs");

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

interface CodeServerFixture {
  root: string;
  script: string;
  log: string;
  path: string;
  host: { node: string; java: string; maven: string; git: string; gitLibexec: string; gitShare: string; pcre: string; zlib: string };
}

async function fixture(): Promise<CodeServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "code-server-script-test-"));
  directories.push(root);
  const infra = join(root, "infra");
  const bin = join(root, "bin");
  const hostRoot = join(root, "host");
  const host = {
    node: join(hostRoot, "node"), java: join(hostRoot, "java"), maven: join(hostRoot, "maven"), git: join(hostRoot, "git"),
    gitLibexec: join(hostRoot, "git-core"), gitShare: join(hostRoot, "git-share"), pcre: join(hostRoot, "libpcre2-8.so.0"), zlib: join(hostRoot, "libz.so.1"),
  };
  const runtimeDirectories = [join(host.node, "bin"), join(host.java, "bin"), join(host.maven, "bin"), host.gitLibexec, host.gitShare];
  const homeDirectories = [join(root, ".m2", "repository"), join(root, ".npm"), join(root, ".pi", "agent", "bin")];
  await Promise.all([mkdir(infra), mkdir(bin), ...runtimeDirectories.map((directory) => mkdir(directory, { recursive: true })), ...homeDirectories.map((directory) => mkdir(directory, { recursive: true }))]);
  const [configuration, configurationReader] = await Promise.all([readFile(sourceConfig, "utf8"), readFile(sourceConfigReader, "utf8")]);
  await Promise.all([
    ...[join(host.node, "bin", "node"), join(host.node, "bin", "npm"), join(host.node, "bin", "corepack"), join(host.node, "bin", "pi"), join(host.java, "bin", "java"), join(host.maven, "bin", "mvn"), host.git]
      .map((file) => symlink(process.execPath, file)),
    writeFile(join(root, "issue-pilot.config.ts"), configuration, "utf8"),
    writeFile(join(infra, "config-value.mjs"), configurationReader, "utf8"),
    writeFile(host.pcre, "", "utf8"), writeFile(host.zlib, "", "utf8"), writeFile(join(root, ".m2", "settings.xml"), "<settings/>\n", "utf8"), writeFile(join(root, ".npmrc"), "", "utf8"),
    ...["auth.json", "models.json", "models-store.json", "settings.json"].map((file) => writeFile(join(root, ".pi", "agent", file), "{}\n", "utf8")),
    ...["rg", "fd"].map((file) => symlink(process.execPath, join(root, ".pi", "agent", "bin", file))),
  ]);

  const replacements = new Map([
    ["/usr/local/node", host.node], ["/usr/local/java", host.java], ["/usr/local/maven", host.maven], ["/usr/bin/git", host.git],
    ["/usr/libexec/git-core", host.gitLibexec], ["/usr/share/git-core", host.gitShare], ["/lib64/libpcre2-8.so.0", host.pcre], ["/lib64/libz.so.1", host.zlib],
  ]);
  let source = await readFile(sourceScript, "utf8");
  for (const [productionPath, fixturePath] of replacements) source = source.replaceAll(productionPath, fixturePath);
  const script = join(infra, "code-server.sh");
  await writeFile(script, source, { mode: 0o755 });
  const log = join(root, "podman.log");
  const podman = join(bin, "podman");
  await writeFile(podman, "#!/bin/sh\nprintf '%s\\n' \"$*\"\nprintf '%s\\n' \"$*\" >> \"$PODMAN_LOG\"\n", { mode: 0o755 });
  return { root, script, log, path: `${bin}:/usr/local/bin:/usr/bin:/bin`, host };
}

test("opens every issue through its generated multi-root runtime", () => {
  const stateRoot = "/srv/issue-pilot/state";
  const issueKey = "ISSUE-20260810-001";
  const runtimeUrl = new URL(issueCodeServerUrl(stateRoot, issueKey, `${stateRoot}/issues/issue-20260810-001/runtime`));
  assert.equal(runtimeUrl.searchParams.get("folder"), null);
  assert.equal(runtimeUrl.searchParams.get("workspace"), "/home/coder/state/issues/issue-20260810-001/runtime/issue-20260810-001.code-workspace");
  assert.throws(() => issueCodeServerUrl(stateRoot, issueKey, `${stateRoot}/workspaces/issue-20260810-001`), /invalid_code_server_workspace/);
  assert.throws(() => issueCodeServerUrl(stateRoot, issueKey, "/srv/other"), /invalid_code_server_workspace/);
});

test("uses one shared code-server container", async () => {
  const value = await fixture();
  const result = await exec(value.script, ["status"], { env: { PATH: value.path, PODMAN_LOG: value.log } });
  assert.match(result.stdout, /inspect --format .* code-server/);
  assert.doesNotMatch(result.stdout, /PASSWORD=/);
  assert.doesNotMatch(result.stdout, /ISSUE-/);
});

test("mounts the fixed host development environment without image rebuilds", async () => {
  const productionSource = await readFile(sourceScript, "utf8");
  for (const mount of [
    "/usr/local/node:/opt/host/node:ro", "/usr/local/java:/opt/host/java:ro", "/usr/local/maven:/opt/host/maven:ro",
    "/usr/bin/git:/opt/host/git/bin/git:ro", "/usr/libexec/git-core:/opt/host/git/libexec/git-core:ro",
  ]) assert.ok(productionSource.includes(mount), `missing production mount: ${mount}`);

  const value = await fixture();
  const stateRoot = join(value.root, "custom-state");
  const environment = { HOME: value.root, PATH: value.path, PODMAN_LOG: value.log };
  await exec(value.script, ["ensure", stateRoot], { env: environment });
  const calls = await readFile(value.log, "utf8");
  assert.match(calls, /image exists ghcr\.io\/coder\/code-server:4\.131\.0-39/);
  assert.doesNotMatch(calls, /podman build| build --file/);
  assert.ok(calls.includes(`--volume ${value.host.node}:/opt/host/node:ro`));
  assert.ok(calls.includes(`--volume ${value.host.java}:/opt/host/java:ro`));
  assert.ok(calls.includes(`--volume ${value.host.maven}:/opt/host/maven:ro`));
  assert.ok(calls.includes(`--volume ${value.root}/.m2:/home/coder/.m2`));
  assert.ok(calls.includes(`--volume ${value.root}/.npm:/home/coder/.npm`));
  assert.ok(calls.includes(`--volume ${value.root}/.pi/agent:/home/coder/.pi/agent`));
  assert.ok(calls.includes(`--volume ${stateRoot}/issues:/home/coder/state/issues:ro`));
  assert.ok(calls.includes(`--volume ${stateRoot}/git/repositories:/home/coder/state/git/repositories`));
  assert.ok(calls.includes(`--volume ${stateRoot}/git/checkouts:/home/coder/state/git/checkouts:ro`));
  assert.ok(calls.includes(`--volume ${value.host.git}:/opt/host/git/bin/git:ro`));
  assert.ok(calls.includes(`--volume ${value.host.gitLibexec}:/opt/host/git/libexec/git-core:ro`));
  assert.ok(calls.includes(`--env-file ${stateRoot}/code-server/container.env`));
  assert.doesNotMatch(calls, /PASSWORD=|--env /);
  assert.match(calls, /--label io\.issue-pilot\.code-server-runtime=keep-id-v24-code-server-4\.131\.0-current-layout-auth-none/);
  assert.match(calls, /--publish 127\.0\.0\.1:18080:8080/);
  assert.match(calls, /--workdir \/home\/coder\/state\/workspaces/);
  assert.match(calls, /--auth none/);
  assert.doesNotMatch(calls, /--bind-addr/);
  const settings = JSON.parse(await readFile(join(stateRoot, "code-server", "data", "User", "settings.json"), "utf8"));
  assert.equal(settings["git.path"], "/opt/host/git/bin/git");
  assert.equal(settings["java.jdt.ls.java.home"], "/opt/host/java");
  assert.equal(settings["maven.executable.path"], "/opt/host/maven/bin/mvn");
  assert.equal("npm.packageManager" in settings, false);
  const containerEnvironment = await readFile(join(stateRoot, "code-server", "container.env"), "utf8");
  assert.doesNotMatch(containerEnvironment, /^PASSWORD=/m);
  assert.match(containerEnvironment, /^PATH=\/home\/coder\/\.pi\/agent\/bin:/m);
  assert.match(containerEnvironment, /^GIT_EXEC_PATH=\/opt\/host\/git\/libexec\/git-core$/m);
  await exec(value.script, ["ensure", stateRoot], { env: environment });
});

test("rejects unsupported command arguments", async () => {
  const value = await fixture();
  await assert.rejects(
    exec(value.script, ["status", "ISSUE-20260803-001"], { env: { PATH: value.path, PODMAN_LOG: value.log } }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === 2),
  );
});
