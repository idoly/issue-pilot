import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readElasticsearch, readRabbitMq, readRedis } from "../../src/evidence/external.ts";
import type { IssuePolicy } from "../../src/pi/policy.ts";

const execFileAsync = promisify(execFile);

test("returns complete Redis, Elasticsearch, and RabbitMQ responses without command-line credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-external-"));
  const workspace = path.join(root, "workspaces", "issue-20260805-100");
  await mkdir(workspace, { recursive: true });
  const policy = {
    workspaceRoot: workspace,
    service: {
      serviceKey: "external", redis: { deploymentId: "deployment-external" }, es: { deploymentId: "deployment-external" }, mq: { deploymentId: "deployment-external", virtualHost: "/" },
    },
  } as IssuePolicy;
  const calls: string[][] = [];
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      assert.equal(args.includes("--rm"), true);
      assert.equal(args.includes("--read-only"), true);
      assert.equal(args.includes("--cap-drop"), true);
      assert.doesNotMatch(args.join(" "), /redis-secret|es-secret|mq-secret/);
      const capability = args.at(-3);
      return { code: 0, stdout: capability === "redis" ? '"value"' : '{"ok":true}', stderr: "", killed: false };
    },
  } as unknown as ExtensionAPI;
  try {
    const redisConfig = { host: "192.168.27.122", port: 6379, username: "", password: "redis-secret", database: 0 };
    const esConfig = { url: "http://es-6.example.test/", username: "elastic", password: "es-secret" };
    const mqConfig = { host: "192.168.27.122", port: 5672, managementPort: 15672, username: "admin", password: "mq-secret", virtualHost: "/" };
    const redis = await readRedis(pi, policy, redisConfig, workspace, { action: "get", key: "order:1" });
    const es = await readElasticsearch(pi, policy, esConfig, workspace, { action: "search", query: { term: { status: "open" } }, limit: 10 });
    const mq = await readRabbitMq(pi, policy, mqConfig, workspace, { action: "queues", limit: 20 });
    assert.match(JSON.stringify(redis), /value/);
    assert.match(JSON.stringify(es), /ok/);
    assert.match(JSON.stringify(mq), /ok/);
    assert.equal(calls.length, 3);
    await assert.rejects(() => readRedis(pi, policy, redisConfig, workspace, { action: "set", key: "order:1" }), /invalid_redis_action/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("executes complete Redis and RabbitMQ runner reads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-external-runner-"));
  const configFile = path.join(root, "config.json");
  const requestFile = path.join(root, "request.json");
  let redisRequest = "";
  const redis = createTcpServer((socket) => socket.on("data", (chunk) => {
    redisRequest += chunk.toString();
    socket.end("$5\r\nvalue\r\n");
  }));
  await new Promise<void>((resolve) => redis.listen(0, "127.0.0.1", resolve));
  const redisAddress = redis.address();
  assert(redisAddress && typeof redisAddress === "object");
  const mqRequests: Array<{ url: string; authorization?: string }> = [];
  const mq = createServer((request, response) => {
    mqRequests.push({ url: request.url ?? "", ...(typeof request.headers.authorization === "string" ? { authorization: request.headers.authorization } : {}) });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(Array.from({ length: 150 }, (_, index) => ({ source: `exchange-${index}` }))));
  });
  await new Promise<void>((resolve) => mq.listen(0, "127.0.0.1", resolve));
  const mqAddress = mq.address();
  assert(mqAddress && typeof mqAddress === "object");
  const runner = path.join(process.cwd(), "infra", "external-read-runner.mjs");
  try {
    await Promise.all([
      writeFile(configFile, JSON.stringify({ host: "127.0.0.1", port: redisAddress.port, username: "", database: 0 })),
      writeFile(requestFile, JSON.stringify({ command: ["GET", "order:1"] })),
    ]);
    const redisExecution = await execFileAsync(process.execPath, [runner, "redis", configFile, requestFile]);
    assert.equal(JSON.parse(redisExecution.stdout), "value");
    assert.match(redisRequest, /GET/);
    assert.match(redisRequest, /order:1/);

    await Promise.all([
      writeFile(configFile, JSON.stringify({ host: "127.0.0.1", managementPort: mqAddress.port, username: "reader", password: "secret", virtualHost: "/" })),
      writeFile(requestFile, JSON.stringify({ action: "bindings", queue: "orders", limit: 3 })),
    ]);
    const mqExecution = await execFileAsync(process.execPath, [runner, "mq", configFile, requestFile]);
    assert.equal((JSON.parse(mqExecution.stdout) as unknown[]).length, 150);
    assert.equal(mqRequests[0]?.url, "/api/queues/%2F/orders/bindings");
    assert.equal(mqRequests[0]?.authorization, `Basic ${Buffer.from("reader:secret").toString("base64")}`);
  } finally {
    await Promise.all([
      new Promise<void>((resolve, reject) => redis.close((error) => error ? reject(error) : resolve())),
      new Promise<void>((resolve, reject) => mq.close((error) => error ? reject(error) : resolve())),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves an Elasticsearch reverse-proxy path and refuses redirects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-es-runner-"));
  const configFile = path.join(root, "config.json");
  const requestFile = path.join(root, "request.json");
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
  try {
    await Promise.all([
      writeFile(configFile, JSON.stringify({ url: `http://127.0.0.1:${address.port}/elastic-proxy`, username: "reader", password: "secret" })),
      writeFile(requestFile, JSON.stringify({ action: "count", body: { query: { match_all: {} } } })),
    ]);
    const runner = path.join(process.cwd(), "infra", "external-read-runner.mjs");
    const execution = await execFileAsync(process.execPath, [runner, "es", configFile, requestFile]);
    assert.deepEqual(JSON.parse(execution.stdout), { count: 3 });
    assert.equal(requests[0]?.url, "/elastic-proxy/_count");
    assert.equal(requests[0]?.authorization, `Basic ${Buffer.from("reader:secret").toString("base64")}`);

    redirect = true;
    await assert.rejects(() => execFileAsync(process.execPath, [runner, "es", configFile, requestFile]));
    assert.equal(requests.some((request) => request.url === "/unexpected"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
