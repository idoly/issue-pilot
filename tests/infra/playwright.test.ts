import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sourceScript = resolve("infra/playwright.sh");
const sourceConfig = resolve("issue-pilot.config.ts");
const sourceConfigReader = resolve("infra/config-value.mjs");

test("prepares Playwright core and the browser image only for application tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "playwright-tools-"));
  const bin = join(root, "bin");
  const infra = join(root, "infra");
  const log = join(root, "tools.log");
  const script = join(infra, "playwright.sh");
  const browserTest = join(root, "application-test.cjs");
  const output = join(root, "output");
  try {
    await Promise.all([mkdir(bin), mkdir(infra), mkdir(output)]);
    for (const [name, content] of [
      ["npm", "#!/bin/sh\nprintf 'npm %s\\n' \"$*\" >> \"$PI_TOOLS_LOG\"\n"],
      ["podman", "#!/bin/sh\nprintf 'podman %s\\n' \"$*\" >> \"$PI_TOOLS_LOG\"\n[ \"$1 $2\" = \"image exists\" ] && exit 1\nexit 0\n"],
    ] as const) {
      await writeFile(join(bin, name), content, "utf8");
      await chmod(join(bin, name), 0o700);
    }
    const [source, configuration, configurationReader] = await Promise.all([
      readFile(sourceScript, "utf8"), readFile(sourceConfig, "utf8"), readFile(sourceConfigReader, "utf8"),
    ]);
    await Promise.all([
      writeFile(join(root, "issue-pilot.config.ts"), configuration.replace("/usr/local/node/lib/node_modules/playwright-core", join(root, "playwright-core")), "utf8"),
      writeFile(join(infra, "config-value.mjs"), configurationReader, "utf8"),
      writeFile(browserTest, "require('/tool/node_modules/playwright-core');\n", "utf8"),
      writeFile(script, source
        .replaceAll("/usr/local/node/bin/node", process.execPath)
        .replaceAll("/usr/local/node/bin/npm", join(bin, "npm")), { mode: 0o700 }),
    ]);
    const env = { PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, PI_TOOLS_LOG: log };
    await execFileAsync(script, ["prepare"], { env });
    await execFileAsync(script, ["run", browserTest, output], { env });
    const calls = await readFile(log, "utf8");
    assert.match(calls, /npm install --global --omit=dev playwright-core@1\.62\.1/);
    assert.match(calls, /podman image exists mcr\.microsoft\.com\/playwright:v1\.62\.1-noble/);
    assert.match(calls, /podman pull mcr\.microsoft\.com\/playwright:v1\.62\.1-noble/);
    assert.match(calls, /podman run --rm --pull never --name issue-pilot-application-test-[0-9]+ --timeout 300 --label io\.issue-pilot\.component=application-test/);
    assert.match(calls, /--pids-limit 256 --memory 1g/);
    assert.match(calls, new RegExp(`${browserTest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\/work\/test\\.cjs:ro,Z`));
    assert.match(calls, new RegExp(`${output.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\/out:rw,z`));
    assert.doesNotMatch(calls, /node:26|maven:|--detach|project-tools\.sock|issues\.db|\/\.issue-pilot\//);
    assert.doesNotMatch(source, /PI_PLAYWRIGHT|\$\{[A-Z_]+:-|playwright_version=1\.62\.1|playwright_image=mcr\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
