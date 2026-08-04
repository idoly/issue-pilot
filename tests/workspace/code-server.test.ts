import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  await writeFile(podman, "#!/bin/sh\nprintf '%s\\n' \"$*\"\n", "utf8");
  await chmod(podman, 0o755);
  return `${directory}:${process.env.PATH}`;
}

test("uses one shared code-server container", async () => {
  const result = await exec(script, ["status"], { env: { ...process.env, PATH: await fakePodmanPath() } });
  assert.match(result.stdout, /inspect code-server/);
  assert.doesNotMatch(result.stdout, /ISSUE-/);
});

test("rejects obsolete per-issue commands", async () => {
  await assert.rejects(
    exec(script, ["status", "ISSUE-20260803-001"], { env: { ...process.env, PATH: await fakePodmanPath() } }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === 2),
  );
});
