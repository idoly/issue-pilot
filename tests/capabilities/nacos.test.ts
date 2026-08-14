import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { readNacosCapability } from "../../src/capabilities/broker.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { readNacosConfigurations, type NacosConnection } from "../../src/capabilities/nacos.ts";

async function nacosServer(): Promise<{
  origin: string;
  requests: URL[];
  loginCount: () => number;
  close: () => Promise<void>;
}> {
  const requests: URL[] = [];
  let logins = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/nacos/v1/auth/login") {
      logins += 1;
      let body = "";
      for await (const chunk of request) body += chunk;
      assert.deepEqual(Object.fromEntries(new URLSearchParams(body)), { username: "managed-user", password: "managed-secret" });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ accessToken: "managed-token" }));
      return;
    }
    assert.equal(url.pathname, "/nacos/v1/cs/configs");
    requests.push(url);
    if (url.searchParams.get("dataId") === "orders-shared.yaml") {
      response.writeHead(404).end();
      return;
    }
    if (url.searchParams.get("dataId") === "oversized.yaml") {
      response.end("x".repeat(issuePilotConfig.limits.capability.resultBytes + 1));
      return;
    }
    response.end("spring:\n  datasource:\n    password: business-secret\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("nacos_test_server_not_started");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    loginCount: () => logins,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function connection(serverUrl: string, dataIds = ["orders.yaml", "orders-shared.yaml"]): NacosConnection {
  return {
    serverUrl,
    namespace: "managed-space",
    group: "MANAGED_GROUP",
    dataIds,
    username: "managed-user",
    password: "managed-secret",
  };
}

test("reads exact Nacos Data IDs over one authenticated bounded HTTP session", async () => {
  const server = await nacosServer();
  try {
    const configured = connection(server.origin);
    const configurations = await readNacosConfigurations(configured);
    assert.deepEqual(configurations, [
      { dataId: "orders.yaml", group: "MANAGED_GROUP", content: "spring:\n  datasource:\n    password: business-secret\n" },
      { dataId: "orders-shared.yaml", group: "MANAGED_GROUP", content: null },
    ]);
    assert.equal(server.loginCount(), 1);
    assert.deepEqual(server.requests.map((url) => Object.fromEntries(url.searchParams)), [
      { dataId: "orders.yaml", group: "MANAGED_GROUP", tenant: "managed-space", accessToken: "managed-token" },
      { dataId: "orders-shared.yaml", group: "MANAGED_GROUP", tenant: "managed-space", accessToken: "managed-token" },
    ]);

    const toolResult = await readNacosCapability("orders", { ...configured, dataIds: ["orders.yaml"] });
    const output = JSON.stringify(toolResult);
    assert.match(output, /business-secret/);
    assert.doesNotMatch(output, /managed-user|managed-secret|managed-token/);
  } finally {
    await server.close();
  }
});

test("rejects invalid targets and oversized Nacos responses", async () => {
  const server = await nacosServer();
  try {
    await assert.rejects(readNacosConfigurations(connection(server.origin, [])), /invalid_nacos_configuration_target/);
    await assert.rejects(readNacosConfigurations(connection(server.origin, ["orders.yaml", "orders.yaml"])), /invalid_nacos_configuration_target/);
    await assert.rejects(readNacosConfigurations(connection(server.origin, ["../orders.yaml"])), /invalid_nacos_configuration_target/);
    await assert.rejects(readNacosConfigurations(connection(server.origin, ["oversized.yaml"])), /capability_result_too_large/);
  } finally {
    await server.close();
  }
});
