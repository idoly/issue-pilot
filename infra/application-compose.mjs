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
  `${hostPath(runtime.projectTools.node.npmCache)}:${hostPath(runtime.projectTools.node.npmCache)}:rw,z`,
  `${hostPath(runtime.projectTools.maven.settings)}:${hostPath(runtime.projectTools.maven.settings)}:ro,z`,
  `${hostPath(runtime.projectTools.maven.repository)}:${hostPath(runtime.projectTools.maven.repository)}:rw,z`,
];
for (const optional of [path.join(home, ".gitconfig"), path.join(home, ".ssh")]) {
  if (fs.existsSync(optional)) mounts.push(`${optional}:${optional}:ro,z`);
}

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
          APP_ROOT: root,
          RUNTIME_HOME: home,
          TARGETARCH: architecture,
        },
      },
      labels: { "io.issue-pilot.component": "application" },
      restart: application.restartPolicy,
      ports: [`0.0.0.0:${issuePilotConfig.http.port}:${issuePilotConfig.http.port}`],
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
  },
};

process.stdout.write(`${JSON.stringify(compose, null, 2)}\n`);
