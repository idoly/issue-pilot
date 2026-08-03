import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

const exec = promisify(execFile);
const directories: string[] = [];
const script = resolve("infra/workspace-podman.sh");

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fakePodmanPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "workspace-podman-test-"));
  directories.push(directory);
  const podman = join(directory, "podman");
  await writeFile(podman, "#!/bin/sh\nprintf '%s\\n' \"$*\"\n", "utf8");
  await chmod(podman, 0o755);
  return `${directory}:${process.env.PATH}`;
}

test("accepts dated and legacy issue keys for workspace commands", async () => {
  const env = { ...process.env, PATH: await fakePodmanPath() };
  const dated = await exec(script, ["status", "ISSUE-20260802-001"], { env });
  const legacy = await exec(script, ["status", "ISSUE-0001"], { env });

  assert.match(dated.stdout, /issue-agent-workspace-issue-20260802-001/);
  assert.match(legacy.stdout, /issue-agent-workspace-issue-0001/);
});

test("rejects malformed dated issue keys before invoking podman", async () => {
  const env = { ...process.env, PATH: await fakePodmanPath() };
  await assert.rejects(
    exec(script, ["status", "ISSUE-20260802-01"], { env }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === 2),
  );
});
