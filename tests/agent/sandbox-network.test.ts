import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { applicationParameters, installApplicationParameters } from "../../src/configuration/parameters.ts";
import { applyIssueSandboxNetwork, prepareIssueCommand } from "../../src/agent/issue-sandbox.ts";
import { executeLocalCommand } from "../../src/process.ts";

test("open networking uses the live mode for HTTP and SOCKS while preserving host denials and explicit lists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-network-mode-"));
  const original = applicationParameters();
  const environmentKeys = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"];
  const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  const upstreamRequests: string[] = [];
  const sockets = new Set<Socket>();
  // A local parent proxy represents remote sites; no request leaves this fixture.
  const upstream = createServer((request, response) => {
    upstreamRequests.push(`${request.method} ${request.url}`);
    request.resume();
    response.end(`${request.method} ${request.url}`);
  });
  upstream.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  upstream.on("connect", (request, socket) => {
    upstreamRequests.push(`CONNECT ${request.url}`);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    let content = "";
    socket.on("data", (chunk) => {
      content += chunk.toString();
      if (!content.includes("\r\n\r\n")) return;
      const body = `${content.split(" ", 1)[0]} ${request.url}`;
      socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
  });
  let prepared: Awaited<ReturnType<typeof prepareIssueCommand>> | undefined;
  const failures: unknown[] = [];
  try {
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    for (const key of environmentKeys) process.env[key] = key.toLowerCase() === "no_proxy" ? "" : upstreamUrl;
    installApplicationParameters({ ...original, networkMode: "allowlist", networkAllowedDomains: [] });
    prepared = await prepareIssueCommand({ writeRoot: root }, [process.execPath, "-e", ""]);
    const proxyPort = SandboxManager.getProxyPort()!;
    const token = SandboxManager.getProxyAuthToken()!;
    const request = (transport: "http" | "socks5h", host: string, method = "GET") =>
      executeLocalCommand(
        "curl",
        ["--silent", "--show-error", "--fail", "--max-time", "4", "--noproxy", "", "--proxy", `${transport}://srt:${token}@127.0.0.1:${proxyPort}`, "-X", method, `http://${host}/probe`],
        {
          cwd: root,
          timeout: 6000,
        },
      );
    const mode = (networkMode: "open" | "allowlist") => installApplicationParameters({ ...applicationParameters(), networkMode });

    for (const transport of ["http", "socks5h"] as const) {
      mode("allowlist");
      assert.notEqual((await request(transport, "public.example.test")).code, 0);
      const before = upstreamRequests.length;
      mode("open");
      const allowed = await request(transport, "public.example.test", "POST");
      assert.equal(allowed.code, 0, allowed.stderr);
      assert.match(allowed.stdout, /^POST /);
      assert.ok(upstreamRequests.length > before);
      for (const host of ["10.20.30.40", "[fd12:3456::1]", "100.64.1.2", "gitlab.internal.example.test"]) {
        const intranet = await request(transport, host);
        assert.equal(intranet.code, 0, `${host}: ${intranet.stderr}`);
      }
      const deniedBefore = upstreamRequests.length;
      for (const host of [
        "localhost",
        "localhost.",
        "other.localhost",
        "other.localhost.",
        "127.0.0.1",
        "127.0.0.2",
        "127.1",
        "0x7f000002",
        "[::1]",
        "[::ffff:127.0.0.2]",
        "0.0.0.0",
        "[::]",
        "169.254.169.254",
        "[fe80::1]",
        "100.100.100.200",
        "168.63.129.16",
        "192.0.0.192",
        "[fd00:ec2::254]",
        "[fd20:ce::254]",
        `public.example.test:${issuePilotConfig.http.port}`,
        `public.example.test:${issuePilotConfig.web.port}`,
      ])
        assert.notEqual((await request(transport, host)).code, 0, `${transport}: ${host}`);
      assert.equal(upstreamRequests.length, deniedBefore, "denied targets never reached the upstream proxy");
      mode("allowlist");
      assert.notEqual((await request(transport, "public.example.test")).code, 0);
      assert.equal(upstreamRequests.length, deniedBefore);
    }

    // Updating the base list reaches this existing proxy, independently of open mode.
    installApplicationParameters({ ...applicationParameters(), networkAllowedDomains: ["public.example.test"] });
    await applyIssueSandboxNetwork();
    assert.equal(SandboxManager.getProxyPort(), proxyPort);
    for (const transport of ["http", "socks5h"] as const) {
      assert.equal((await request(transport, "public.example.test")).code, 0);
      assert.notEqual((await request(transport, "other.example.test")).code, 0);
    }

    // A mode change governs new connections; it does not revoke an accepted tunnel.
    mode("open");
    const tunnel = connect(proxyPort, "127.0.0.1");
    tunnel.setTimeout(5000, () => tunnel.destroy(new Error("fixture_tunnel_timeout")));
    const completed = new Promise<string>((resolve, reject) => {
      let received = "",
        accepted = false;
      tunnel.on("error", reject);
      tunnel.on("data", (chunk) => {
        received += chunk.toString();
        if (!accepted && received.includes("\r\n\r\n")) {
          accepted = true;
          mode("allowlist");
          tunnel.write("GET /existing HTTP/1.1\r\nHost: existing.example.test\r\nConnection: close\r\n\r\n");
        }
      });
      tunnel.on("end", () => resolve(received));
    });
    tunnel.write(`CONNECT existing.example.test:80 HTTP/1.1\r\nHost: existing.example.test:80\r\nProxy-Authorization: Basic ${Buffer.from(`srt:${token}`).toString("base64")}\r\n\r\n`);
    try {
      assert.match(await completed, /GET existing\.example\.test:80/);
      assert.notEqual((await request("http", "existing.example.test")).code, 0);
    } finally {
      tunnel.destroy();
    }
  } catch (error) {
    failures.push(error);
  } finally {
    const cleanup = await Promise.allSettled([prepared?.cleanup()]);
    installApplicationParameters(original);
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const socket of sockets) socket.destroy();
    cleanup.push(...(await Promise.allSettled([new Promise<void>((resolve) => upstream.close(() => resolve())), rm(root, { recursive: true, force: true })])));
    failures.push(...cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "network_fixture_cleanup_failed");
});
