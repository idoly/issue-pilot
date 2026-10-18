import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { readElasticsearch } from "../../src/capabilities/elasticsearch.ts";
import { readRabbitMq } from "../../src/capabilities/rabbitmq.ts";
import { readRedis } from "../../src/capabilities/redis.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-external-"));
  return { root };
}

async function within<T>(promise: Promise<T>, milliseconds = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("condition_not_met")), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("reads Redis through node-redis and retains the read-only command boundary", async () => {
  const { root } = await fixture();
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
    const result = await readRedis(config, { action: "get", key: "order:1" });
    assert.match(result.content[0]!.text, /value/);
    assert.match(redisRequest, /AUTH/);
    assert.match(redisRequest, /redis-secret/);
    assert.match(redisRequest, /GET/);
    assert.match(redisRequest, /order:1/);
  } finally {
    await new Promise<void>((resolve, reject) => redisServer.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes Redis server failures without exposing upstream error text", async () => {
  const { root } = await fixture();
  const redisServer = createTcpServer((socket) => {
    socket.once("data", () => socket.end("-WRONGPASS redis-secret rejected\r\n"));
  });
  await new Promise<void>((resolve) => redisServer.listen(0, "127.0.0.1", resolve));
  const address = redisServer.address();
  assert(address && typeof address === "object");
  try {
    await assert.rejects(
      () => readRedis({ host: "127.0.0.1", port: address.port, username: "", password: "redis-secret", database: 0 }, { action: "get", key: "order:1" }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error.message, "redis_read_failed");
        assert.doesNotMatch(error.message, /redis-secret|WRONGPASS/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve) => redisServer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("terminates the Redis worker connection when the capability is aborted", async () => {
  const { root } = await fixture();
  let commandReceived!: () => void;
  let connectionClosed!: () => void;
  const received = new Promise<void>((resolve) => { commandReceived = resolve; });
  const closed = new Promise<void>((resolve) => { connectionClosed = resolve; });
  const redisServer = createTcpServer((socket) => {
    socket.once("data", commandReceived);
    socket.once("close", connectionClosed);
  });
  await new Promise<void>((resolve) => redisServer.listen(0, "127.0.0.1", resolve));
  const address = redisServer.address();
  assert(address && typeof address === "object");
  const controller = new AbortController();
  try {
    const pending = readRedis({ host: "127.0.0.1", port: address.port, username: "", database: 0 }, { action: "get", key: "order:1" }, controller.signal);
    await within(received);
    controller.abort(new Error("redis_abort_requested"));
    await assert.rejects(pending, /redis_abort_requested/);
    await within(closed);
  } finally {
    controller.abort();
    await new Promise<void>((resolve) => redisServer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("reads RabbitMQ management data with encoded scope and credentials", async () => {
  const { root } = await fixture();
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
    const config = { host: "127.0.0.1", managementPort: address.port, username: "reader", password: "secret", virtualHost: "/" };
    const result = await readRabbitMq(config, { action: "bindings", queue: "orders" });
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
  const { root } = await fixture();
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
    await assert.rejects(() => readRedis({ host: "127.0.0.1", port: redisAddress.port, username: "", database: 0 }, { action: "get", key: "large" }), /capability_result_too_large/);
    await assert.rejects(() => readRabbitMq({ host: "127.0.0.1", managementPort: httpAddress.port, username: "reader", password: "secret", virtualHost: "/" }, { action: "overview" }), /capability_result_too_large/);
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => redisServer.close(() => resolve())),
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves an Elasticsearch reverse-proxy path and refuses redirects", async () => {
  const { root } = await fixture();
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
    const result = await readElasticsearch(config, { action: "count", query: { match_all: {} } });
    assert.deepEqual(JSON.parse(result.content[0]!.text), { action: "count", output: { count: 3 } });
    assert.equal(requests[0]?.url, "/elastic-proxy/_count");
    assert.equal(requests[0]?.authorization, `Basic ${Buffer.from("reader:secret").toString("base64")}`);

    redirect = true;
    await assert.rejects(() => readElasticsearch(config, { action: "count", query: { match_all: {} } }));
    assert.equal(requests.some((request) => request.url === "/unexpected"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
