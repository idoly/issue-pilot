import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sourceScript = resolve("infra/playwright.sh");

test("prepares global Playwright core and only the browser image", async () => {
  const root = await mkdtemp(join(tmpdir(), "playwright-tools-"));
  const bin = join(root, "bin");
  const log = join(root, "tools.log");
  const script = join(root, "playwright.sh");
  try {
    await mkdir(bin);
    for (const [name, content] of [
      ["node", "#!/bin/sh\nexit 0\n"],
      ["npm", "#!/bin/sh\nprintf 'npm %s\\n' \"$*\" >> \"$PI_TOOLS_LOG\"\n"],
      ["podman", "#!/bin/sh\nprintf 'podman %s\\n' \"$*\" >> \"$PI_TOOLS_LOG\"\n[ \"$1 $2\" = \"image exists\" ] && exit 1\nexit 0\n"],
    ] as const) {
      await writeFile(join(bin, name), content, "utf8");
      await chmod(join(bin, name), 0o700);
    }
    const source = await readFile(sourceScript, "utf8");
    await writeFile(script, source
      .replaceAll("/usr/local/node/bin/node", join(bin, "node"))
      .replaceAll("/usr/local/node/bin/npm", join(bin, "npm"))
      .replaceAll("/usr/local/node/lib/node_modules/playwright-core", join(root, "playwright-core")), { mode: 0o700 });
    await execFileAsync(script, ["prepare"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_TOOLS_LOG: log } });
    const calls = await readFile(log, "utf8");
    assert.match(calls, /npm install --global --omit=dev playwright-core@1\.62\.1/);
    assert.match(calls, /podman image exists mcr\.microsoft\.com\/playwright:v1\.62\.1-noble/);
    assert.match(calls, /podman pull mcr\.microsoft\.com\/playwright:v1\.62\.1-noble/);
    assert.doesNotMatch(calls, /node:26|maven:|podman run|--name|--detach/);
    assert.doesNotMatch(source, /PI_PLAYWRIGHT|\$\{[A-Z_]+:-/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
