import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer as createProxy } from "node:http";
import { createServer } from "node:https";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { readSlsLogs } from "../../src/capabilities/sls.ts";
import { localCommandExecutor, type CommandExecutor } from "../../src/process.ts";

const exec = promisify(execFile);
const configured = { region: "cn-hangzhou", project: "fixture", logstores: ["logs"], accessKeyId: "fixture-key", accessKeySecret: "fixture-secret" };
const query = { region: configured.region, project: configured.project, logstore: "logs", from: 1_700_000_000, to: 1_700_000_300 };
const page = (data: unknown[], progress = "Complete") => ({ meta: { hasSQL: false, progress }, data });

test("real aliyun CLI uses isolated HTTPS, pagination, diagnostics, budgets and cancellation", { timeout: 60_000 }, async (context) => {
  const version = (await exec("aliyun", ["version"])).stdout.trim();
  context.diagnostic(`aliyun ${version}`);
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-sls-protocol-"));
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  let server: ReturnType<typeof createServer> | undefined, proxy: ReturnType<typeof createProxy> | undefined;
  try {
    const key = path.join(root, "key.pem"),
      certificate = path.join(root, "cert.pem");
    await exec("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      key,
      "-out",
      certificate,
      "-subj",
      "/CN=fixture.localhost",
      "-addext",
      "subjectAltName=DNS:fixture.localhost",
    ]);
    let respond: (body: Record<string, unknown>) => { status: number; body: unknown } | undefined = () => undefined;
    const requests: Record<string, unknown>[] = [];
    const failures: unknown[] = [];
    server = createServer({ key: await readFile(key), cert: await readFile(certificate) }, async (request, response) => {
      try {
        assert.equal(request.method, "POST");
        assert.equal(request.url, "/logstores/logs/logs");
        assert.ok(request.headers.authorization?.includes(configured.accessKeyId));
        let body = "";
        for await (const chunk of request) body += chunk;
        const input = JSON.parse(body) as Record<string, unknown>;
        requests.push(input);
        const result = respond(input);
        if (!result) return; // A deliberately stalled response exercises process cancellation.
        response.writeHead(result.status, { "content-type": "application/json", "x-log-requestid": "fixture" });
        response.end(JSON.stringify(result.body));
      } catch (error) {
        failures.push(error);
        response.writeHead(500).end();
      }
    });
    server.on("connection", track);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const endpoint = `localhost:${port}`;
    // SLS prepends the project to its endpoint. Tunnel that exact host to loopback without changing DNS or disabling TLS.
    proxy = createProxy((_request, response) => response.writeHead(403).end());
    proxy.on("connection", track);
    proxy.on("connect", (request, downstream, head) => {
      if (request.url !== `fixture.${endpoint}`) {
        failures.push(new Error("unexpected_proxy_target"));
        downstream.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const upstream = connect(port, "127.0.0.1", () => {
        downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        downstream.pipe(upstream);
        upstream.pipe(downstream);
      });
      track(upstream);
      upstream.on("error", () => downstream.destroy());
      downstream.on("error", () => upstream.destroy());
      downstream.on("close", () => upstream.destroy());
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const profiles: string[] = [];
    const executor: CommandExecutor = {
      async execute(command, args, options) {
        assert.equal(command, "aliyun");
        assert.ok(args.includes("--secure"));
        assert.equal(args[args.indexOf("--retry-count") + 1], "0");
        assert.doesNotMatch(JSON.stringify(args), /fixture-key|fixture-secret/);
        const profile = args[args.indexOf("--config-path") + 1]!;
        profiles.push(profile);
        assert.equal((await stat(profile)).mode & 0o777, 0o600);
        assert.equal(JSON.parse(await readFile(profile, "utf8")).profiles[0].access_key_secret, configured.accessKeySecret);
        assert.equal(options?.environment?.ALIBABA_CLOUD_ACCESS_KEY_ID, undefined);
        return localCommandExecutor.execute(command, [...args, "--endpoint", endpoint], {
          ...options,
          environment: { ...options?.environment, SSL_CERT_FILE: certificate, HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, NO_PROXY: "", no_proxy: "" },
        });
      },
    };
    await context.test("paginates actual CLI output and retains source metadata", async () => {
      respond = (body) => ({ status: 200, body: page(body.offset === 0 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ message: "订单", token: "requested-business-token" }]) });
      const result = await readSlsLogs(query, configured, undefined, executor);
      const output = JSON.parse(result.content[0]!.text);
      assert.equal(output.records.length, 101);
      assert.equal(output.records[100].token, "requested-business-token");
      assert.equal(output.query.project, configured.project);
      assert.equal(output.query.from, query.from);
      assert.deepEqual(
        requests.map(({ offset }) => offset),
        [0, 100],
      );
      assert.ok(requests.every((body) => body.line === 100 && body.reverse === true && body.query === "*"));
      assert.doesNotMatch(JSON.stringify(result), /fixture-key|fixture-secret/);
    });
    await context.test("a failed later page is not retried or exposed as partial success", async () => {
      requests.length = 0;
      respond = (body) =>
        body.offset === 0
          ? { status: 200, body: page(Array.from({ length: 100 }, () => ({}))) }
          : { status: 403, body: { errorCode: "Unauthorized", errorMessage: "fixture-secret private diagnostic" } };
      await assert.rejects(readSlsLogs(query, configured, undefined, executor), (error) => error instanceof Error && error.message === "sls_access_denied" && error.cause === undefined);
      assert.deepEqual(
        requests.map(({ offset }) => offset),
        [0, 100],
      );
    });
    await context.test("rejects incomplete evidence", async () => {
      requests.length = 0;
      respond = () => ({ status: 200, body: page([{ message: "partial" }], "Incomplete") });
      await assert.rejects(readSlsLogs(query, configured, undefined, executor), { message: "sls_query_incomplete" });
      assert.equal(requests.length, 1);
    });
    await context.test("terminates an oversized CLI response", async () => {
      requests.length = 0;
      respond = () => ({ status: 200, body: page([{ message: "x".repeat(issuePilotConfig.limits.capability.resultBytes) }]) });
      await assert.rejects(readSlsLogs(query, configured, undefined, executor), { message: "command_output_too_large" });
      assert.equal(requests.length, 1);
    });
    await context.test("cancels a real process waiting for the HTTPS response", async () => {
      const controller = new AbortController();
      const reason = new Error("fixture_cancelled");
      let markReceived!: () => void;
      const received = new Promise<void>((resolve) => {
        markReceived = resolve;
      });
      respond = () => {
        markReceived();
        return undefined;
      };
      const result = readSlsLogs(query, configured, controller.signal, executor);
      try {
        await Promise.race([received, result]);
        controller.abort(reason);
        await assert.rejects(result, (error) => error === reason);
      } finally {
        controller.abort(reason);
      }
    });
    assert.deepEqual(failures, []);
    for (const profile of profiles) await assert.rejects(access(profile), { code: "ENOENT" });
  } finally {
    for (const socket of sockets) socket.destroy();
    try {
      await Promise.all([server, proxy].filter((value) => value !== undefined).map((value) => new Promise<void>((resolve, reject) => value.close((error) => (error ? reject(error) : resolve())))));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
