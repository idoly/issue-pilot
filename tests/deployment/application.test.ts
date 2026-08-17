import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

const containerfilePath = "Containerfile";
const manifestPath = "deploy/issue-pilot.yaml";

test("builds one application image with the required project tools", async () => {
  const containerfile = await readFile(containerfilePath, "utf8");

  assert.match(containerfile, /FROM docker\.io\/library\/node:26-bookworm-slim AS build/);
  assert.match(containerfile, /FROM docker\.io\/library\/maven:3\.9-eclipse-temurin-8 AS maven/);
  assert.equal(containerfile.match(/FROM docker\.io\/library\/node:26-bookworm-slim/g)?.length, 2);
  assert.match(containerfile, /npm ci/);
  assert.match(containerfile, /npm prune --omit=dev/);
  assert.match(containerfile, /apt-get install .* ca-certificates curl git openssh-client ripgrep/);
  assert.match(containerfile, /ARG ALIYUN_CLI_VERSION=3\.4\.11/);
  assert.match(containerfile, /github\.com\/aliyun\/aliyun-cli\/releases\/download\/v\$\{ALIYUN_CLI_VERSION\}/);
  assert.match(containerfile, /sha256sum --check/);
  assert.match(containerfile, /COPY --from=maven \/opt\/java\/openjdk/);
  assert.match(containerfile, /COPY --from=maven \/usr\/share\/maven/);
  assert.match(containerfile, /node_modules\/\.bin\/pi/);
  assert.match(containerfile, /USER node/);
  assert.match(containerfile, /src\/http\/production\.ts/);
  assert.match(containerfile, /COPY --from=build \/build \/opt\/issue-pilot/);
  assert.doesNotMatch(containerfile, /podman|docker\.sock|legacy-peer-deps|COPY vendor/);
});

test("deploys one recreate application with direct host mounts", async () => {
  const manifest = await readFile(manifestPath, "utf8");

  assert.match(manifest, /kind: Deployment/);
  assert.match(manifest, /replicas: 1/);
  assert.match(manifest, /strategy:\n\s+type: Recreate/);
  assert.match(manifest, /automountServiceAccountToken: false/);
  assert.match(manifest, /nodeSelector:\n\s+issue-pilot\/state: "true"/);
  assert.match(manifest, /terminationGracePeriodSeconds: 1800/);
  assert.match(manifest, /readOnlyRootFilesystem: true/);
  assert.match(manifest, /capabilities:\n\s+drop:\n\s+- ALL/);
  assert.match(manifest, /startupProbe:[\s\S]*readinessProbe:[\s\S]*livenessProbe:/);
  assert.match(manifest, /mountPath: \/opt\/issue-pilot\/\.issue-pilot/);
  assert.match(manifest, /hostPath:\n\s+path: \/var\/lib\/issue-pilot\n\s+type: Directory/);
  assert.match(manifest, /name: runtime-config\n\s+mountPath: \/home\/node\n\s+readOnly: true/);
  assert.match(manifest, /name: runtime-config\n\s+hostPath:\n\s+path: \/etc\/issue-pilot\n\s+type: Directory/);
  assert.doesNotMatch(manifest, /secretName:|subPath:/);
  assert.match(manifest, /kind: Service[\s\S]*type: ClusterIP/);
  assert.doesNotMatch(manifest, /initContainers:|persistentVolumeClaim|docker\.sock|podman\.sock/);
});

test("does not retain the Compose deployment layer", async () => {
  for (const path of ["infra/application.sh", "infra/application-compose.mjs", "infra/config-value.mjs", "deploy/kubernetes/base"]) {
    await assert.rejects(access(path));
  }
});
