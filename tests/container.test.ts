import assert from "node:assert/strict";
import { test } from "node:test";

import { PodmanContainerRuntime, UnavailableContainerRuntime } from "../src/container-runtime.ts";
import { ephemeralContainerArgs } from "../src/container.ts";
import type { CommandExecutor } from "../src/capabilities/local-exec.ts";

test("builds one hardened ephemeral container contract", () => {
  const args = ephemeralContainerArgs({
    image: "registry.example.test/tool@sha256:abc",
    command: ["query", "line one\nline two"],
    label: "io.issue-pilot.component=pi-tool",
    pids: 64,
    memory: "128m",
    uid: 1000,
    gid: 1000,
    networkHost: true,
    environment: { HOME: "/tmp/home", CI: "1" },
    mounts: [
      { source: "/srv/project", target: "/workspace", access: "rw", relabel: "shared" },
      { source: "/srv/secret", target: "/run/secret", access: "ro", relabel: "private" },
    ],
    tmpfs: ["/tmp:rw,nosuid,nodev,size=16m"],
    workdir: "/workspace/project",
  });
  assert.deepEqual(args.slice(0, 4), ["run", "--rm", "--pull", "never"]);
  for (const value of ["no-new-privileges", "ALL", "64", "128m", "keep-id", "1000:1000", "host", "HOME=/tmp/home", "CI=1", "/srv/project:/workspace:rw,z", "/srv/secret:/run/secret:ro,Z", "/tmp:rw,nosuid,nodev,size=16m", "/workspace/project"]) assert.ok(args.includes(value), value);
  assert.deepEqual(args.slice(args.indexOf("registry.example.test/tool@sha256:abc")), ["registry.example.test/tool@sha256:abc", "query", "line one\nline two"]);
});

test("keeps the Podman CLI behind the container runtime boundary", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const executor: CommandExecutor = { async execute(command, args) { calls.push({ command, args }); return { stdout: "ok", stderr: "", code: 0, killed: false }; } };
  const runtime = new PodmanContainerRuntime(executor);
  const result = await runtime.run({ image: "tool", command: ["version"], label: "io.issue-pilot.component=pi-tool", pids: 1, memory: "64m", uid: 1000, gid: 1000 });
  assert.equal(result.stdout, "ok");
  assert.equal(calls[0]!.command, "podman");
  assert.deepEqual(calls[0]!.args.slice(-2), ["tool", "version"]);
});

test("fails closed when a deployment has no ephemeral container adapter", async () => {
  await assert.rejects(new UnavailableContainerRuntime().run({ image: "unused", command: [], label: "unused", pids: 1, memory: "1m", uid: 1, gid: 1 }), /container_runtime_unavailable/);
});

test("rejects unsafe container configuration without interpreting command arguments", () => {
  const base = {
    image: "tool",
    command: ["run"],
    label: "io.issue-pilot.component=pi-tool",
    pids: 1,
    memory: "1g",
    uid: 1000,
    gid: 1000,
  } as const;
  assert.throws(() => ephemeralContainerArgs({ ...base, mounts: [{ source: "/tmp/a:b", target: "/data", access: "ro" }] }), /invalid_container_configuration/);
  assert.throws(() => ephemeralContainerArgs({ ...base, environment: { "BAD-NAME": "value" } }), /invalid_container_configuration/);
  assert.throws(() => ephemeralContainerArgs({ ...base, command: ["bad\0argument"] }), /invalid_container_configuration/);
  assert.throws(() => ephemeralContainerArgs({ ...base, memory: "unlimited" }), /invalid_container_configuration/);
});
