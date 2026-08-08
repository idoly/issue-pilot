import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

const exec = promisify(execFile);
const directories: string[] = [];
const sourceScript = resolve("infra/code-server.sh");

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fixture(): Promise<{ root: string; script: string; log: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "code-server-script-test-"));
  directories.push(root);
  const infra = join(root, "infra");
  const bin = join(root, "bin");
  const log = join(root, "podman.log");
  await Promise.all([mkdir(infra), mkdir(bin)]);
  const script = join(infra, "code-server.sh");
  await copyFile(sourceScript, script);
  await chmod(script, 0o755);
  const podman = join(bin, "podman");
  await writeFile(podman, "#!/bin/sh\nprintf '%s\\n' \"$*\"\nprintf '%s\\n' \"$*\" >> \"$PODMAN_LOG\"\n", "utf8");
  await chmod(podman, 0o755);
  return { root, script, log, path: `${bin}:${process.env.PATH}` };
}

test("uses one shared code-server container", async () => {
  const value = await fixture();
  const result = await exec(value.script, ["status"], { env: { ...process.env, PATH: value.path, PODMAN_LOG: value.log } });
  assert.match(result.stdout, /inspect code-server/);
  assert.doesNotMatch(result.stdout, /ISSUE-/);
});

test("mounts the fixed host development environment without image rebuilds", async () => {
  const value = await fixture();
  await exec(value.script, ["ensure"], { env: { ...process.env, PATH: value.path, PODMAN_LOG: value.log } });
  const calls = await readFile(value.log, "utf8");
  assert.match(calls, /image exists ghcr\.io\/coder\/code-server:4\.131\.0-39/);
  assert.doesNotMatch(calls, /podman build| build --file/);
  assert.match(calls, /--volume \/usr\/local\/node:\/opt\/host\/node:ro/);
  assert.match(calls, /--volume \/usr\/local\/java:\/opt\/host\/java:ro/);
  assert.match(calls, /--volume \/usr\/local\/maven:\/opt\/host\/maven:ro/);
  assert.match(calls, new RegExp(`--volume ${process.env.HOME}/\\.m2:/home/coder/\\.m2`));
  assert.match(calls, new RegExp(`--volume ${process.env.HOME}/\\.npm:/home/coder/\\.npm`));
  assert.match(calls, new RegExp(`--volume ${process.env.HOME}/\\.pi/agent:/home/coder/\\.pi/agent`));
  assert.match(calls, /--volume \/usr\/bin\/git:\/opt\/host\/git\/bin\/git:ro/);
  assert.match(calls, /--volume \/usr\/libexec\/git-core:\/opt\/host\/git\/libexec\/git-core:ro/);
  assert.match(calls, /--env GIT_EXEC_PATH=\/opt\/host\/git\/libexec\/git-core/);
  assert.match(calls, /--label io\.issue-pilot\.code-server-runtime=keep-id-v17-code-server-4\.131\.0-host-development-runtime/);
  assert.match(calls, /--workdir \/home\/coder\/state\/workspaces/);
  assert.doesNotMatch(calls, /--bind-addr/);
  const settings = JSON.parse(await readFile(join(value.root, ".issue-pilot", "code-server", "data", "User", "settings.json"), "utf8"));
  assert.equal(settings["git.path"], "/opt/host/git/bin/git");
  assert.equal(settings["java.jdt.ls.java.home"], "/opt/host/java");
  assert.equal(settings["maven.executable.path"], "/opt/host/maven/bin/mvn");
});

test("rejects obsolete per-issue commands", async () => {
  const value = await fixture();
  await assert.rejects(
    exec(value.script, ["status", "ISSUE-20260803-001"], { env: { ...process.env, PATH: value.path, PODMAN_LOG: value.log } }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === 2),
  );
});
