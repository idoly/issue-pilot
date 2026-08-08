import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readNacosConfigurations, type NacosConnection } from "../../src/capabilities/configuration.ts";
import type { CommandExecutor } from "../../src/capabilities/local-exec.ts";
import { readConfiguration } from "../../src/capabilities/queries.ts";

const connection: NacosConnection = {
  serverUrl: "https://managed-nacos.example.test",
  namespace: "managed-space",
  group: "MANAGED_GROUP",
  dataIds: ["orders.yaml", "orders-shared.yaml"],
  username: "managed-user",
  password: "managed-secret",
};

test("reads only page-authorized Nacos data IDs through the managed connection", async () => {
  const calls: string[][] = [];
  const profiles: Array<Record<string, unknown>> = [];
  const pi: CommandExecutor = {
    async exec(command, args) {
      calls.push([command, ...args]);
      const profileMount = args.find((argument) => argument.endsWith(":/run/secret:ro,z"))!;
      profiles.push(JSON.parse(await readFile(`${profileMount.slice(0, profileMount.indexOf(":"))}/connection.json`, "utf8")) as Record<string, unknown>);
      const dataId = args.at(-2);
      if (dataId === "orders-shared.yaml") return { code: 1, stdout: "", stderr: "nacos_configuration_read_failed:404", killed: false };
      return { code: 0, stdout: "spring:\n  datasource:\n    password: business-secret\n", stderr: "", killed: false };
    },
  };

  const configurations = await readNacosConfigurations(pi, connection);
  assert.deepEqual(configurations, [
    { dataId: "orders.yaml", group: "MANAGED_GROUP", content: "spring:\n  datasource:\n    password: business-secret\n" },
    { dataId: "orders-shared.yaml", group: "MANAGED_GROUP", content: null },
  ]);
  assert.deepEqual(profiles.map((profile) => ({ host: profile.host, namespace: profile.namespace, username: profile.username, password: profile.password })), [
    { host: "managed-nacos.example.test", namespace: "managed-space", username: "managed-user", password: "managed-secret" },
    { host: "managed-nacos.example.test", namespace: "managed-space", username: "managed-user", password: "managed-secret" },
  ]);
  for (const call of calls) {
    assert.equal(call[0], "podman");
    assert.equal(call[call.indexOf("--pids-limit") + 1], "64");
    assert.equal(call[call.indexOf("--memory") + 1], "128m");
    assert.equal(call.at(-1), "MANAGED_GROUP");
    assert.doesNotMatch(call.join(" "), /managed-user|managed-secret/);
  }

  const toolResult = await readConfiguration(pi, "orders", { ...connection, dataIds: ["orders.yaml"] });
  const output = JSON.stringify(toolResult);
  assert.match(output, /business-secret/);
  assert.doesNotMatch(output, /managed-user|managed-secret/);
});

test("rejects missing, duplicate, and invalid Nacos targets", async () => {
  const pi = { async exec() { throw new Error("unexpected_execution"); } } as CommandExecutor;
  await assert.rejects(readNacosConfigurations(pi, { ...connection, dataIds: [] }), /invalid_nacos_configuration_target/);
  await assert.rejects(readNacosConfigurations(pi, { ...connection, dataIds: ["orders.yaml", "orders.yaml"] }), /invalid_nacos_configuration_target/);
  await assert.rejects(readNacosConfigurations(pi, { ...connection, dataIds: ["../orders.yaml"] }), /invalid_nacos_configuration_target/);
});
