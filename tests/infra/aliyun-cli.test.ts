import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sourceScript = resolve("infra/aliyun-cli.sh");
const sourceDockerfile = resolve("infra/images/aliyun-cli/Dockerfile");
const sourceConfig = resolve("issue-pilot.config.ts");
const sourceConfigReader = resolve("infra/config-value.mjs");

test("builds and verifies the pinned multi-architecture Aliyun CLI image", async () => {
  const root = await mkdtemp(join(tmpdir(), "aliyun-cli-image-"));
  const bin = join(root, "bin");
  const infra = join(root, "infra");
  const imageRoot = join(infra, "images", "aliyun-cli");
  const log = join(root, "tools.log");
  const script = join(infra, "aliyun-cli.sh");
  try {
    await Promise.all([mkdir(bin), mkdir(imageRoot, { recursive: true })]);
    const podman = join(bin, "podman");
    await writeFile(podman, "#!/bin/sh\nprintf 'podman %s\\n' \"$*\" >> \"$PI_TOOLS_LOG\"\nif [ \"$1\" = run ]; then printf '3.4.11\\n'; fi\nexit 0\n", { mode: 0o700 });
    const [source, dockerfile, configuration, configurationReader] = await Promise.all([
      readFile(sourceScript, "utf8"), readFile(sourceDockerfile, "utf8"), readFile(sourceConfig, "utf8"), readFile(sourceConfigReader, "utf8"),
    ]);
    await Promise.all([
      writeFile(join(root, "issue-pilot.config.ts"), configuration, "utf8"),
      writeFile(join(infra, "config-value.mjs"), configurationReader, "utf8"),
      writeFile(join(imageRoot, "Dockerfile"), dockerfile, "utf8"),
      writeFile(script, source.replaceAll("/usr/local/node/bin/node", process.execPath), { mode: 0o700 }),
    ]);

    const environment = { PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, PI_TOOLS_LOG: log };
    await execFileAsync(script, ["prepare"], { env: environment });
    await execFileAsync(script, ["status"], { env: environment });
    const calls = await readFile(log, "utf8");
    assert.match(calls, /podman build --pull=always --tag localhost\/issue-pilot-aliyun-cli:3\.4\.11-alpine3\.22\.1/);
    assert.match(calls, /--build-arg TARGETARCH=amd64 --build-arg ALIYUN_CLI_VERSION=3\.4\.11/);
    assert.match(calls, /podman run --rm --read-only --security-opt no-new-privileges --cap-drop ALL localhost\/issue-pilot-aliyun-cli:3\.4\.11-alpine3\.22\.1 version/);
    assert.match(calls, /podman ps --filter label=io\.issue-pilot\.component=pi-tool/);
    assert.match(dockerfile, /alpine:3\.22\.1@sha256:[0-9a-f]{64}/);
    assert.match(dockerfile, /a7e3df497db14c10d4d7587795e9fa7849b0c51dfce02908b9de5a41fe717d5c/);
    assert.match(dockerfile, /b0b6f6f7545f9472b697fc27915c8956e5a3320a6160729dcc5b4eff21435ae8/);
    assert.match(dockerfile, /strip \/usr\/local\/bin\/aliyun/);
    assert.match(dockerfile, /apk del \.build-deps/);
    assert.match(dockerfile, /USER 65532:65532/);
    assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/aliyun"\]/);
    assert.doesNotMatch(dockerfile, /latest|ACCESS_KEY|SECRET/i);
    assert.doesNotMatch(source, /ISSUE_PILOT_|\$\{[A-Z_]+:-/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
