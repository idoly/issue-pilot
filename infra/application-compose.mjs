import fs from "node:fs";
import path from "node:path";

import { issuePilotConfig } from "../issue-pilot.config.ts";

const root = path.resolve(import.meta.dirname, "..");
const home = process.env.HOME;
if (!home || !path.isAbsolute(home)) throw new Error("absolute_home_required");

const architecture = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : undefined;
if (!architecture) throw new Error(`unsupported_architecture:${process.arch}`);

const { runtime, state } = issuePilotConfig;
const application = runtime.application;
const stateRoot = path.resolve(root, state.directory);
const hostPath = (relative) => path.resolve(home, relative);
const mounts = [
  `${stateRoot}:${stateRoot}:rw,z`,
  `${path.join(home, ".pi", "agent")}:${path.join(home, ".pi", "agent")}:ro,z`,
  `${hostPath(runtime.projectTools.node.npmConfig)}:${hostPath(runtime.projectTools.node.npmConfig)}:ro,z`,
  `${hostPath(runtime.projectTools.node.npmCache)}:${hostPath(runtime.projectTools.node.npmCache)}:ro,z`,
  `${hostPath(runtime.projectTools.maven.settings)}:${hostPath(runtime.projectTools.maven.settings)}:ro,z`,
  `${hostPath(runtime.projectTools.maven.repository)}:${hostPath(runtime.projectTools.maven.repository)}:ro,z`,
  `${application.podmanSocket}:/run/podman/podman.sock:rw`,
];
for (const optional of [path.join(home, ".gitconfig"), path.join(home, ".ssh")]) {
  if (fs.existsSync(optional)) mounts.push(`${optional}:${optional}:ro,z`);
}

const restrictedToolService = (image, command) => ({
  profiles: ["tools"],
  image,
  command,
  network_mode: "none",
  read_only: true,
  security_opt: ["no-new-privileges"],
  cap_drop: ["ALL"],
  user: `${runtime.containerUser.uid}:${runtime.containerUser.gid}`,
  pids_limit: runtime.projectTools.containerPids,
  mem_limit: runtime.projectTools.containerMemory,
  tmpfs: ["/tmp:rw,nosuid,nodev,size=64m"],
});

const compose = {
  name: application.name,
  services: {
    application: {
      image: application.image,
      container_name: application.name,
      build: {
        context: root,
        dockerfile: path.join(root, "infra", "images", "application", "Containerfile"),
        args: {
          NODE_IMAGE: runtime.projectTools.node.image,
          APP_ROOT: root,
          TARGETARCH: architecture,
          PODMAN_REMOTE_VERSION: application.podmanRemote.version,
          PODMAN_REMOTE_SHA256: application.podmanRemote[`${architecture}Sha256`],
        },
      },
      labels: { "io.issue-pilot.component": "application" },
      restart: application.restartPolicy,
      ports: [`127.0.0.1:${issuePilotConfig.http.port}:${issuePilotConfig.http.port}`],
      read_only: true,
      security_opt: ["no-new-privileges"],
      cap_drop: ["ALL"],
      userns_mode: "keep-id",
      user: `${runtime.containerUser.uid}:${runtime.containerUser.gid}`,
      pids_limit: application.containerPids,
      mem_limit: application.containerMemory,
      stop_grace_period: `${application.stopTimeoutSeconds}s`,
      environment: { HOME: home },
      volumes: mounts,
      tmpfs: ["/tmp:rw,nosuid,nodev,size=1g"],
      working_dir: root,
    },
    "node-tool": restrictedToolService(runtime.projectTools.node.image, ["node", "--version"]),
    "maven-tool": restrictedToolService(runtime.projectTools.maven.image, ["mvn", "--version"]),
    "aliyun-tool": {
      ...restrictedToolService(runtime.aliyunCli.image, ["version"]),
      build: {
        context: path.join(root, "infra", "images", "aliyun-cli"),
        dockerfile: path.join(root, "infra", "images", "aliyun-cli", "Dockerfile"),
        args: { TARGETARCH: architecture, ALIYUN_CLI_VERSION: runtime.aliyunCli.version },
      },
      user: "65532:65532",
      pids_limit: runtime.aliyunCli.containerPids,
      mem_limit: runtime.aliyunCli.containerMemory,
    },
  },
};

process.stdout.write(`${JSON.stringify(compose, null, 2)}\n`);
