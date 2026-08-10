import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { readElasticsearch, readRabbitMq, readRedis } from "../../src/capabilities/external-data.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { IssuePolicy } from "../../src/pi/policy.ts";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-external-"));
  const policy = {
    workspaceRoot: root,
    service: {
      serviceKey: "external",
      redis: { deploymentId: "deployment-external" },
      es: { deploymentId: "deployment-external" },
      mq: { deploymentId: "deployment-external", virtualHost: "/" },
    },
  } as IssuePolicy;
  return { root, policy };
}

test("reads Redis through node-redis and retains the read-only command boundary", async () => {
  const { root, policy } = await fixture();
  let redisRequest = "";
  const redisServer = createTcpServer((socket) => {
    let authReplied = false;
    let getReplied = false;
    socket.on("data", (chunk) => {
      redisRequest += chunk.toString();
      if (!authReplied && redisRequest.includes("AUTH")) {
        authReplied = true;
        socket.write("+OK\r\n");
      }
      if (!getReplied && redisRequest.includes("GET")) {
        getReplied = true;
        socket.write("$5\r\nvalue\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => redisServer.listen(0, "127.0.0.1", resolve));
  const address = redisServer.address();
  assert(address && typeof address === "object");
  const config = { host: "127.0.0.1", port: address.port, username: "", password: "redis-secret", database: 0 };
  try {
    const result = await readRedis(policy, config, { action: "get", key: "order:1" });
    assert.match(result.content[0]!.text, /value/);
    assert.match(redisRequest, /AUTH/);
    assert.match(redisRequest, /redis-secret/);
    assert.match(redisRequest, /GET/);
    assert.match(redisRequest, /order:1/);
    await assert.rejects(() => readRedis(policy, config, { action: "set", key: "order:1" }), /invalid_redis_action/);
  } finally {
    await new Promise<void>((resolve, reject) => redisServer.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("reads RabbitMQ management data with encoded scope and credentials", async () => {
  const { root, policy } = await fixture();
  const requests: Array<{ url: string; authorization?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? "", ...(typeof request.headers.authorization === "string" ? { authorization: request.headers.authorization } : {}) });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(Array.from({ length: 150 }, (_, index) => ({ source: `exchange-${index}` }))));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    const config = { host: "127.0.0.1", port: 5672, managementPort: address.port, username: "reader", password: "secret", virtualHost: "/" };
    const result = await readRabbitMq(policy, config, { action: "bindings", queue: "orders" });
    const output = JSON.parse(result.content[0]!.text) as { output: unknown[] };
    assert.equal(output.output.length, 150);
    assert.equal(requests[0]?.url, "/api/queues/%2F/orders/bindings");
    assert.equal(requests[0]?.authorization, `Basic ${Buffer.from("reader:secret").toString("base64")}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects oversized native Redis and HTTP responses before returning them", async () => {
  const { root, policy } = await fixture();
  const redisServer = createTcpServer((socket) => {
    socket.once("data", () => {
      const value = "x".repeat(issuePilotConfig.limits.capability.resultBytes + 1);
      socket.end(`$${value.length}\r\n${value}\r\n`);
    });
  });
  const httpServer = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(Buffer.alloc(issuePilotConfig.limits.capability.resultBytes + 1, 120));
  });
  await Promise.all([
    new Promise<void>((resolve) => redisServer.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve)),
  ]);
  const redisAddress = redisServer.address();
  const httpAddress = httpServer.address();
  assert(redisAddress && typeof redisAddress === "object");
  assert(httpAddress && typeof httpAddress === "object");
  try {
    await assert.rejects(() => readRedis(policy, { host: "127.0.0.1", port: redisAddress.port, username: "", database: 0 }, { action: "get", key: "large" }), /capability_result_too_large/);
    await assert.rejects(() => readRabbitMq(policy, { host: "127.0.0.1", port: 5672, managementPort: httpAddress.port, username: "reader", password: "secret", virtualHost: "/" }, { action: "overview" }), /capability_result_too_large/);
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => redisServer.close(() => resolve())),
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves an Elasticsearch reverse-proxy path and refuses redirects", async () => {
  const { root, policy } = await fixture();
  const requests: Array<{ url: string; authorization?: string }> = [];
  let redirect = false;
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? "", ...(typeof request.headers.authorization === "string" ? { authorization: request.headers.authorization } : {}) });
    if (redirect) { response.writeHead(302, { location: "/unexpected" }).end(); return; }
    response.setHeader("content-type", "application/json");
    response.end('{"count":3}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const config = { url: `http://127.0.0.1:${address.port}/elastic-proxy`, username: "reader", password: "secret" };
  try {
    const result = await readElasticsearch(policy, config, { action: "count", query: { match_all: {} } });
    assert.deepEqual(JSON.parse(result.content[0]!.text), { action: "count", output: { count: 3 } });
    assert.equal(requests[0]?.url, "/elastic-proxy/_count");
    assert.equal(requests[0]?.authorization, `Basic ${Buffer.from("reader:secret").toString("base64")}`);

    redirect = true;
    await assert.rejects(() => readElasticsearch(policy, config, { action: "count", query: { match_all: {} } }));
    assert.equal(requests.some((request) => request.url === "/unexpected"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
