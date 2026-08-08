import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const script = resolve("infra/pi-tools.sh");

test("prepares pinned connector binaries without persistent tool containers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const workspace = join(root, "workspaces");
  const log = join(root, "podman.log");
  try {
    await Promise.all([mkdir(bin), mkdir(home), mkdir(workspace)]);
    const podman = join(bin, "podman");
    await writeFile(podman, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PODMAN_LOG"\nif [ "$1 $2" = "volume exists" ]; then exit 0; fi\nexit 0\n`, "utf8");
    await chmod(podman, 0o700);
    await execFileAsync(script, ["prepare"], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, PODMAN_LOG: log, PI_WORKSPACE_ROOT: workspace, PI_TOOL_CACHE_ROOT: join(root, "cache") } });
    const calls = await readFile(log, "utf8");
    assert.doesNotMatch(calls, /--name |--detach| sleep infinity/);
    assert.doesNotMatch(calls, /nacos-cli|nacos-cli-data|volume create/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
