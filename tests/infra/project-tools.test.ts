import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sourceScript = resolve("infra/project-tools.sh");
const sourceConfig = resolve("issue-pilot.config.ts");
const sourceConfigReader = resolve("infra/config-value.mjs");

test("prepares and verifies pinned official Node and Maven project images", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-tools-infra-"));
  const bin = join(root, "bin");
  const infra = join(root, "infra");
  const log = join(root, "tools.log");
  const script = join(infra, "project-tools.sh");
  try {
    await Promise.all([mkdir(bin), mkdir(infra), mkdir(join(root, ".npm")), mkdir(join(root, ".m2", "repository"), { recursive: true })]);
    await Promise.all([
      writeFile(join(root, ".npmrc"), "fixture npm configuration\n", { mode: 0o600 }),
      writeFile(join(root, ".m2", "settings.xml"), "<settings/>\n", { mode: 0o600 }),
    ]);
    await writeFile(join(bin, "podman"), `#!/bin/sh
printf 'podman %s\n' "$*" >> "$PI_TOOLS_LOG"
if [ "$1" = run ]; then
  case "$*" in *maven*) printf 'Apache Maven 3.9.16\n' ;; *) printf 'v24.19.0\n' ;; esac
fi
exit 0
`, { mode: 0o700 });
    const [source, configuration, configurationReader] = await Promise.all([readFile(sourceScript, "utf8"), readFile(sourceConfig, "utf8"), readFile(sourceConfigReader, "utf8")]);
    await Promise.all([
      writeFile(join(root, "issue-pilot.config.ts"), configuration, "utf8"),
      writeFile(join(infra, "config-value.mjs"), configurationReader, "utf8"),
      writeFile(script, source.replaceAll("/usr/local/node/bin/node", process.execPath), { mode: 0o700 }),
    ]);
    const environment = { PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, HOME: root, PI_TOOLS_LOG: log };
    await execFileAsync(script, ["prepare"], { env: environment });
    const status = await execFileAsync(script, ["status"], { env: environment });
    const calls = await readFile(log, "utf8");
    assert.match(calls, /podman pull docker\.io\/library\/node:24-bookworm-slim@sha256:[0-9a-f]{64}/);
    assert.match(calls, /podman pull docker\.io\/library\/maven:3\.9-eclipse-temurin-8@sha256:[0-9a-f]{64}/);
    assert.match(calls, /podman run --rm --read-only --security-opt no-new-privileges --cap-drop ALL .*node.* node --version/);
    assert.match(calls, /podman run --rm --read-only --security-opt no-new-privileges --cap-drop ALL --env HOME=\/tmp\/home --env MAVEN_CONFIG=\/tmp\/home\/\.m2 --tmpfs \/tmp:rw,nosuid,nodev,size=64m .*maven.* mvn --version/);
    assert.match(calls, /podman ps --filter label=io\.issue-pilot\.component=pi-tool/);
    assert.match(status.stdout, /v24\.19\.0/);
    assert.match(status.stdout, /Apache Maven 3\.9\.16/);
    assert.doesNotMatch(source, /ISSUE_PILOT_|ACCESS_KEY|SECRET/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
