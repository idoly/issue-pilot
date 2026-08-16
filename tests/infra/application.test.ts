import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sourceScript = path.resolve("infra/application.sh");
const sourceContainerfile = path.resolve("infra/images/application/Containerfile");
const sourceComposeGenerator = path.resolve("infra/application-compose.mjs");
const sourceConfig = path.resolve("issue-pilot.config.ts");
const sourceConfigReader = path.resolve("infra/config-value.mjs");
const kubernetesBase = path.resolve("deploy/kubernetes/base");

async function listen(socketPath: string): Promise<ReturnType<typeof createServer>> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

test("keeps the Kubernetes application baseline single-writer and fail closed", async () => {
  const [kustomization, serviceAccount, service, statefulSet] = await Promise.all([
    readFile(path.join(kubernetesBase, "kustomization.yaml"), "utf8"),
    readFile(path.join(kubernetesBase, "service-account.yaml"), "utf8"),
    readFile(path.join(kubernetesBase, "service.yaml"), "utf8"),
    readFile(path.join(kubernetesBase, "stateful-set.yaml"), "utf8"),
  ]);
  for (const resource of ["service-account.yaml", "service.yaml", "stateful-set.yaml"]) assert.match(kustomization, new RegExp(`- ${resource}`));
  assert.match(serviceAccount, /automountServiceAccountToken: false/);
  assert.match(service, /type: ClusterIP/);
  assert.match(statefulSet, /kind: StatefulSet/);
  assert.match(statefulSet, /replicas: 1/);
  assert.match(statefulSet, /type: OnDelete/);
  assert.match(statefulSet, /whenDeleted: Retain[\s\S]*whenScaled: Retain/);
  assert.match(statefulSet, /--container-runtime=unavailable/);
  assert.match(statefulSet, /readOnlyRootFilesystem: true/);
  assert.match(statefulSet, /accessModes:\n\s+- ReadWriteOnce/);
  assert.match(statefulSet, /mountPath: \/opt\/issue-pilot\/\.issue-pilot/);
  assert.match(statefulSet, /startupProbe:[\s\S]*readinessProbe:[\s\S]*livenessProbe:/);
  assert.doesNotMatch(statefulSet, /hostPath:|docker\.sock|podman\.sock/);
});

test("builds and starts one path-consistent hardened application container", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-application-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const infra = path.join(root, "infra");
  const imageRoot = path.join(infra, "images", "application");
  const socketPath = path.join(root, "podman.sock");
  const log = path.join(root, "podman.log");
  const script = path.join(infra, "application.sh");
  let socketServer: ReturnType<typeof createServer> | undefined;
  try {
    await Promise.all([
      mkdir(bin),
      mkdir(imageRoot, { recursive: true }),
      mkdir(path.join(root, ".issue-pilot")),
      mkdir(path.join(home, ".pi", "agent"), { recursive: true }),
      mkdir(path.join(home, ".npm"), { recursive: true }),
      mkdir(path.join(home, ".m2", "repository"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(home, ".npmrc"), "fixture=true\n", { mode: 0o600 }),
      writeFile(path.join(home, ".m2", "settings.xml"), "<settings/>\n", { mode: 0o600 }),
    ]);
    socketServer = await listen(socketPath);
    await writeFile(path.join(bin, "podman"), `#!/bin/sh
printf 'podman %s\n' "$*" >> "$PI_APPLICATION_LOG"
case "$1 $2" in
  "image exists") exit 0 ;;
  "image inspect") case "$*" in *Healthcheck*) printf 'configured\n' ;; *"$PI_PORTABLE_IMAGE"*) printf '/opt/issue-pilot\n' ;; *) printf '%s\n' "$PI_APPLICATION_ROOT" ;; esac ;;
  "container exists") exit 1 ;;
  "run --detach") printf 'fixture-container-id\n' ;;
esac
exit 0
`, { mode: 0o700 });
    const [source, containerfile, composeGenerator, configuration, configurationReader] = await Promise.all([
      readFile(sourceScript, "utf8"),
      readFile(sourceContainerfile, "utf8"),
      readFile(sourceComposeGenerator, "utf8"),
      readFile(sourceConfig, "utf8"),
      readFile(sourceConfigReader, "utf8"),
    ]);
    const configured = configuration.replace("/run/user/1000/podman/podman.sock", socketPath);
    await Promise.all([
      writeFile(path.join(root, "issue-pilot.config.ts"), configured),
      writeFile(path.join(infra, "config-value.mjs"), configurationReader),
      writeFile(path.join(infra, "application-compose.mjs"), composeGenerator),
      writeFile(path.join(imageRoot, "Containerfile"), containerfile),
      writeFile(script, source.replaceAll("/usr/local/node/bin/node", process.execPath), { mode: 0o700 }),
    ]);
    const environment = {
      PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
      HOME: home,
      PI_APPLICATION_LOG: log,
      PI_APPLICATION_ROOT: root,
      PI_PORTABLE_IMAGE: "registry.example.test/issue-pilot:test",
    };
    const { stdout: manifestText } = await execFileAsync(process.execPath, ["--experimental-strip-types", path.join(infra, "application-compose.mjs")], { env: environment });
    const manifest = JSON.parse(manifestText) as { name: string; services: Record<string, Record<string, unknown>> };
    assert.equal(manifest.name, "issue-pilot");
    assert.deepEqual(Object.keys(manifest.services), ["application", "node-tool", "maven-tool", "aliyun-tool"]);
    assert.deepEqual(manifest.services.application!.cap_drop, ["ALL"]);
    assert.equal(manifest.services.application!.network_mode, undefined);
    assert.deepEqual(manifest.services.application!.ports, ["127.0.0.1:3000:3000"]);
    assert.equal(manifest.services.application!.read_only, true);
    assert.equal(manifest.services.application!.userns_mode, "keep-id");
    assert.equal(manifest.services.application!.stop_grace_period, "1800s");
    const volumes = manifest.services.application!.volumes as string[];
    assert.ok(volumes.includes(`${path.join(root, ".issue-pilot")}:${path.join(root, ".issue-pilot")}:rw,z`));
    assert.ok(volumes.includes(`${socketPath}:/run/podman/podman.sock:rw`));
    assert.deepEqual(manifest.services["node-tool"]!.profiles, ["tools"]);
    assert.deepEqual(manifest.services["maven-tool"]!.profiles, ["tools"]);
    assert.deepEqual(manifest.services["aliyun-tool"]!.profiles, ["tools"]);

    await execFileAsync(script, ["prepare"], { env: environment });
    await execFileAsync(script, ["prepare-kubernetes", environment.PI_PORTABLE_IMAGE], { env: environment });
    await execFileAsync(script, ["start"], { env: environment });
    const calls = await readFile(log, "utf8");
    assert.match(calls, /podman compose --in-pod false --no-ansi --project-name issue-pilot --file .* --podman-build-args=--format=docker --profile tools build --pull=always application aliyun-tool/);
    assert.match(calls, /podman compose --in-pod false --no-ansi --project-name issue-pilot --file .* --profile tools pull node-tool maven-tool/);
    assert.match(calls, /podman build --pull=always --format=docker --file .*Containerfile --tag registry\.example\.test\/issue-pilot:test .*--build-arg APP_ROOT=\/opt\/issue-pilot/);
    assert.match(calls, /podman compose --in-pod false --no-ansi --project-name issue-pilot --file .* up --detach --no-build application/);
    assert.doesNotMatch(calls, /podman run --detach|--privileged|--publish/);
    assert.match(containerfile, /FROM \$\{NODE_IMAGE\} AS build/);
    assert.match(containerfile, /ARG APP_ROOT=\/opt\/issue-pilot/);
    assert.match(containerfile, /COPY vendor \.\/vendor\nRUN npm ci/);
    assert.match(containerfile, /npm prune --omit=dev/);
    assert.doesNotMatch(containerfile, /legacy-peer-deps/);
    assert.match(containerfile, /XDG_CONFIG_HOME=.*podman-remote --url unix:\/\/\/run\/podman\/podman\.sock/);
    assert.match(containerfile, /sha256sum --check --strict/);
    assert.doesNotMatch(containerfile, /install .*podman ripgrep/);
    assert.match(containerfile, /HEALTHCHECK .*127\.0\.0\.1:3000\/health/);
    assert.match(containerfile, /src\/http\/production\.ts/);
    assert.doesNotMatch(source, /ISSUE_PILOT_|\$\{[A-Z_]+:-/);
  } finally {
    if (socketServer) await new Promise<void>((resolve) => socketServer!.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
