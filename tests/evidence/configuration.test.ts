import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { resolveConfiguration, sanitizedConfiguration } from "../../src/evidence/configuration.ts";
import type { ServiceCapability } from "../../src/pi/policy.ts";

const execFileAsync = promisify(execFile);

test("resolves datasource configuration through Nacos without exposing bootstrap credentials", async () => {
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
    const service: ServiceCapability = {
      serviceKey: "orders",
      environmentKey: "test",
      environmentKind: "test",
      codeAccess: "write",
      repositoryPath: repository,
      baseCommit: stdout.trim(),
      capabilities: ["configuration_read", "database_read"],
    };
    const calls: string[][] = [];
    const pi = {
      async exec(command: string, args: string[]) {
        calls.push([command, ...args]);
        const dataId = args.at(-2);
        if (dataId === "orders.yaml" || dataId === "optional-missing.yaml") return { code: 1, stdout: "", stderr: "Error: get config failed (404 Not Found): resource not found", killed: false };
        return {
          code: 0,
          stdout: dataId === "orders-shared.yaml" ? "shared:\n  enabled: true\n" : "spring:\n  datasource:\n    url: jdbc:mysql://mysql.example.test:3306/orders\n    username: readonly\n    password: database-secret\n",
          stderr: "",
          killed: false,
        };
      },
    } as unknown as ExtensionAPI;
    await assert.rejects(resolveConfiguration(pi, service), /nacos_server_not_allowed/);
    assert.equal(calls.length, 0);
    const resolved = await resolveConfiguration(pi, service, undefined, {}, ["http://nacos.example.test:8848"]);
    assert.equal(resolved.properties["spring.datasource.url"], "jdbc:mysql://mysql.example.test:3306/orders");
    assert.equal(resolved.properties["spring.datasource.password"], "database-secret");
    assert.equal(resolved.properties["unrelated.secret"], undefined);
    assert.equal(resolved.properties["resolver.datasource-profile"], true);
    assert.equal(resolved.properties["resolver.boot-profile"], true);
    assert.equal(resolved.properties["shared.enabled"], true);
    assert.deepEqual(resolved.sources, ["repository:bootstrap.yml", "repository:bootstrap-boot.yml", "repository:bootstrap-datasource.yml", "repository:bootstrap-env-test.yml", "nacos:orders-shared.yaml/DEFAULT_GROUP", "nacos:orders-env-test.yaml/DEFAULT_GROUP"]);
    assert.deepEqual(resolved.missingSources, ["nacos:orders.yaml/DEFAULT_GROUP"]);
    const visible = JSON.stringify(sanitizedConfiguration(resolved));
    assert.doesNotMatch(visible, /nacos-secret|database-secret/);
    assert.match(visible, /\[REDACTED\]/);
    const command = calls.flat().join(" ");
    assert.match(command, /config-get orders-shared\.yaml DEFAULT_GROUP/);
    assert.match(command, /config-get orders\.yaml DEFAULT_GROUP/);
    assert.match(command, /config-get orders-env-test\.yaml DEFAULT_GROUP/);
    assert.doesNotMatch(command, /nacos-secret|nacos-user/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
