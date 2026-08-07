import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

const exec = promisify(execFile);
const directories: string[] = [];
const script = resolve("infra/code-server.sh");

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fakePodmanPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "code-server-script-test-"));
  directories.push(directory);
  const podman = join(directory, "podman");
  await writeFile(podman, "#!/bin/sh\nprintf '%s\\n' \"$*\"\n[ -z \"${PODMAN_LOG:-}\" ] || printf '%s\\n' \"$*\" >> \"$PODMAN_LOG\"\n", "utf8");
  await chmod(podman, 0o755);
  return `${directory}:${process.env.PATH}`;
}

test("uses one shared code-server container", async () => {
  const result = await exec(script, ["status"], { env: { ...process.env, PATH: await fakePodmanPath() } });
  assert.match(result.stdout, /inspect code-server/);
  assert.doesNotMatch(result.stdout, /ISSUE-/);
});

test("mounts the host Pi runtime and persistent Pi configuration into code-server", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "code-server-state-test-"));
  directories.push(stateRoot);
  const log = join(stateRoot, "podman.log");
  await exec(script, ["ensure"], { env: { ...process.env, PATH: await fakePodmanPath(), PODMAN_LOG: log, ISSUE_PILOT_STATE_ROOT: stateRoot } });
  const calls = await readFile(log, "utf8");
  assert.match(calls, /ghcr\.io\/coder\/code-server:4\.131\.0-39/);
  assert.match(calls, /--volume \/usr\/local\/node:\/opt\/node:ro/);
  assert.match(calls, /--env PATH=\/opt\/git\/bin:\/opt\/node\/bin:/);
  assert.match(calls, new RegExp(`--volume ${stateRoot}/code-server/pi:/home/coder/\\.pi/agent:Z`));
  assert.match(calls, new RegExp(`--volume ${stateRoot}/code-server/data:/home/coder/\\.local/share/code-server:Z`));
  assert.match(calls, new RegExp(`--volume ${stateRoot}/workspaces:/home/coder/state/workspaces:Z`));
  assert.match(calls, new RegExp(`--volume ${stateRoot}/repositories:/home/coder/state/repositories:Z`));
  assert.match(calls, /--volume \/usr\/bin\/git:\/opt\/git\/bin\/git:ro/);
  assert.match(calls, /--volume \/usr\/libexec\/git-core:\/opt\/git\/libexec\/git-core:ro/);
  assert.match(calls, /--env GIT_EXEC_PATH=\/opt\/git\/libexec\/git-core/);
  assert.match(calls, /--label io\.issue-pilot\.code-server-runtime=keep-id-v10-code-server-4\.131\.0-mounted-pi-0\.84\.0-trusted-workspaces/);
  assert.deepEqual(JSON.parse(await readFile(join(stateRoot, "code-server", "data", "User", "settings.json"), "utf8")), {
    "security.workspace.trust.enabled": false,
    "git.path": "/opt/git/bin/git",
    "git.autoRepositoryDetection": "subFolders",
    "git.repositoryScanMaxDepth": 2,
  });
});

test("rejects obsolete per-issue commands", async () => {
  await assert.rejects(
    exec(script, ["status", "ISSUE-20260803-001"], { env: { ...process.env, PATH: await fakePodmanPath() } }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === 2),
  );
});
