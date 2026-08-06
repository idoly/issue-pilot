import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { resolveConfiguration, resolveConfigurations } from "../../src/evidence/configuration.ts";
import type { GrantedRepository } from "../../src/pi/policy.ts";

const execFileAsync = promisify(execFile);

test("discovers configuration scopes in a multi-module repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-multi-config-"));
  const repository = join(root, "repository");
  try {
    await Promise.all([
      mkdir(join(repository, "service-a", "src", "main", "resources"), { recursive: true }),
      mkdir(join(repository, "service-b", "src", "main", "resources"), { recursive: true }),
    ]);
    await writeFile(join(repository, "service-a", "src", "main", "resources", "bootstrap.yml"), "spring:\n  application:\n    name: service-a\n", "utf8");
    await writeFile(join(repository, "service-b", "src", "main", "resources", "application-test.yml"), "feature:\n  service-b: true\n", "utf8");
    await execFileAsync("git", ["init", repository]);
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "fixture"]);
    const { stdout } = await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" });
    const service: GrantedRepository = { serviceKey: "multi", environmentKey: "test", environmentKind: "test", codeAccess: "read", repositoryPath: repository, baseCommit: stdout.trim() };
    const resolved = await resolveConfigurations({} as ExtensionAPI, service);
    assert.deepEqual(resolved.map((entry) => entry.scope), ["service-a", "service-b"]);
    assert.equal(resolved[0]!.configuration.properties["spring.application.name"], "service-a");
    assert.equal(resolved[1]!.configuration.properties["feature.service-b"], true);
    await assert.rejects(resolveConfiguration({} as ExtensionAPI, service), /multiple_service_configuration_scopes_found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves complete datasource configuration through Nacos", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-config-resolver-"));
  const repository = join(root, "repository");
  try {
    await mkdir(join(repository, "modules", "payments"), { recursive: true });
    await writeFile(join(repository, "bootstrap.yml"), [
      "spring:",
      "  application:",
      "    name: orders",
      "  profiles:",
      "    active: env-test",
      "    include: datasource,boot",
      "  config:",
      "    import: optional:nacos:optional-missing.yaml",
      "  cloud:",
      "    nacos:",
      "      username: nacos-user",
      "      password: nacos-secret",
      "      config:",
      "        file-extension: yaml",
      "        shared-configs:",
      "          - data-id: orders-shared.yaml",
      "",
    ].join("\n"), "utf8");
    await writeFile(join(repository, "bootstrap-env-test.yml"), "spring:\n  cloud:\n    nacos:\n      config:\n        server-addr: http://nacos.example.test\n        namespace: test-space\n", "utf8");
    await writeFile(join(repository, "bootstrap-datasource.yml"), "resolver:\n  datasource-profile: true\n", "utf8");
    await writeFile(join(repository, "bootstrap-boot.yml"), "resolver:\n  boot-profile: true\n", "utf8");
    await writeFile(join(repository, "modules", "payments", "application-test.yml"), "unrelated:\n  secret: must-not-be-merged\n", "utf8");
    await execFileAsync("git", ["init", repository]);
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "fixture"]);
    const { stdout } = await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" });
    const service: GrantedRepository = {
      serviceKey: "orders",
      environmentKey: "test",
      environmentKind: "test",
      codeAccess: "write",
      repositoryPath: repository,
      baseCommit: stdout.trim(),
    };
    const calls: string[][] = [];
    let remoteAttemptsConnectionOverride = false;
    const pi = {
      async exec(command: string, args: string[]) {
        calls.push([command, ...args]);
        const dataId = args.at(-2);
        if (dataId === "orders-shared.yaml" && args.includes("--profile")) return { code: 1, stdout: "", stderr: "Error: login failed: status=403", killed: false };
        if (dataId === "orders.yaml" || dataId === "optional-missing.yaml") return { code: 1, stdout: "", stderr: "Error: get config failed (404 Not Found): resource not found", killed: false };
        return {
          code: 0,
          stdout: dataId === "orders-shared.yaml"
            ? remoteAttemptsConnectionOverride ? "spring:\n  cloud:\n    nacos:\n      config:\n        server-addr: http://untrusted.example.test\n      username: attacker\n      password: attacker-secret\n" : "shared:\n  enabled: true\n"
            : "spring:\n  datasource:\n    url: jdbc:mysql://mysql.example.test:3306/orders\n    username: readonly\n    password: database-secret\n",
          stderr: "",
          killed: false,
        };
      },
    } as unknown as ExtensionAPI;
    const resolved = await resolveConfiguration(pi, service);
    assert.equal(resolved.properties["spring.datasource.url"], "jdbc:mysql://mysql.example.test:3306/orders");
    assert.equal(resolved.properties["spring.datasource.password"], "database-secret");
    assert.equal(resolved.properties["unrelated.secret"], undefined);
    assert.equal(resolved.properties["resolver.datasource-profile"], true);
    assert.equal(resolved.properties["resolver.boot-profile"], true);
    assert.equal(resolved.properties["shared.enabled"], true);
    assert.equal(calls.some((call) => call.some((argument) => argument.includes("nacos-config-get.mjs")) && call.includes("orders-shared.yaml")), true);
    assert.deepEqual(resolved.sources, ["repository:bootstrap.yml", "repository:bootstrap-boot.yml", "repository:bootstrap-datasource.yml", "repository:bootstrap-env-test.yml", "nacos:orders-shared.yaml/DEFAULT_GROUP", "nacos:orders-env-test.yaml/DEFAULT_GROUP"]);
    assert.deepEqual(resolved.missingSources, ["nacos:orders.yaml/DEFAULT_GROUP"]);
    const visible = JSON.stringify(resolved);
    assert.match(visible, /nacos-secret|database-secret/);
    const command = calls.flat().join(" ");
    assert.match(command, /config-get orders-shared\.yaml DEFAULT_GROUP/);
    assert.match(command, /config-get orders\.yaml DEFAULT_GROUP/);
    assert.match(command, /config-get orders-env-test\.yaml DEFAULT_GROUP/);
    assert.doesNotMatch(command, /nacos-secret|nacos-user/);

    calls.length = 0;
    remoteAttemptsConnectionOverride = true;
    const [managed] = await resolveConfigurations(pi, service, undefined, {}, {
      serverUrl: "https://managed-nacos.example.test",
      namespace: "managed-space",
      group: "MANAGED_GROUP",
      username: "managed-user",
      password: "managed-secret",
    });
    assert.equal(managed?.configuration.properties["spring.cloud.nacos.config.server-addr"], "https://managed-nacos.example.test");
    assert.equal(managed?.configuration.properties["spring.cloud.nacos.config.username"], "managed-user");
    assert.equal(managed?.configuration.properties["spring.cloud.nacos.config.password"], "managed-secret");
    assert.equal(managed?.configuration.properties["spring.cloud.nacos.password"], "managed-secret");
    const managedCliCalls = calls.filter((call) => call.includes("config-get"));
    assert.equal(managedCliCalls.length > 1, true);
    for (const call of managedCliCalls) {
      assert.equal(call[call.indexOf("--host") + 1], "managed-nacos.example.test");
      assert.equal(call.at(-1), "MANAGED_GROUP");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
