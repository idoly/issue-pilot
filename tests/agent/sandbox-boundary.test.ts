import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createUnixServer } from "node:net";
import fs, { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { issueNativeTools } from "../../src/agent/native-tools.ts";
import { prepareIssueCommand, shellQuote } from "../../src/agent/issue-sandbox.ts";
import { executeLocalCommand } from "../../src/process.ts";

test("concurrent sandbox cleanup calls wait for the same resource shutdown", async context => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-sandbox-cleanup-"));
  const prepared = await prepareIssueCommand({ writeRoot: root }, [process.execPath, "-e", ""]);
  const remove = fs.rm;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first: Promise<void> | undefined, second: Promise<void> | undefined;
  let secondSettled = false, removals = 0;
  try {
    context.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]).startsWith(path.join(root, ".runtime-proxy-"))) {
        removals++; entered(); await gate;
      }
      return remove(...args);
    });
    syncBuiltinESMExports();
    first = prepared.cleanup(); await started;
    second = prepared.cleanup();
    const observed = second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(secondSettled, false);
    release(); await Promise.all([first, second]); await observed;
    assert.equal(removals, 1);
  } finally {
    release(); await Promise.allSettled([first, second]);
    context.mock.restoreAll(); syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("stdio sandbox Git protection includes stores created after the connection starts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-mcp-git-"));
  const store = path.join(root, ".issue-git", "a".repeat(20)), config = path.join(store, "config");
  const code = `try { require('node:fs').writeFileSync(${JSON.stringify(config)}, 'compromised'); process.exit(0); } catch { process.exit(17); }`;
  const prepared = await prepareIssueCommand({ writeRoot: root, gitAccess: "read" }, [process.execPath, "-e", code]);
  try {
    await mkdir(store, { recursive: true });
    await writeFile(config, "trusted");
    const result = await executeLocalCommand(prepared.argv[0]!, prepared.argv.slice(1), { cwd: root });
    assert.equal(result.code, 17);
    assert.equal(await readFile(config, "utf8"), "trusted");
  } finally { await prepared.cleanup(); await rm(root, { recursive: true, force: true }); }
});

test("SRT blocks direct and proxy access to host HTTP and visible Unix sockets that could write another Issue", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-host-services-")), own = path.join(root, "own"), outside = path.join(root, "outside.txt");
  await mkdir(own); await writeFile(outside, "untouched"); let requests = 0;
  const http = createHttpServer((_request, response) => { requests++; void writeFile(outside, "HTTP escaped").then(() => response.end("done")); });
  const unix = createUnixServer(socket => { requests++; void writeFile(outside, "Unix escaped").then(() => socket.end("done")); });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const socketPath = path.join(own, "host.sock"); await new Promise<void>(resolve => unix.listen(socketPath, resolve));
  try {
    const port = (http.address() as { port: number }).port;
    const bash = issueNativeTools({ writeRoot: own }).find(tool => tool.name === "bash")!;
    const run = async (command: string) => {
      const result = await bash.execute("boundary", { command }, undefined, undefined, {} as never);
      return result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    };
    assert.match(await run(`curl --fail --max-time 2 --noproxy '*' -X POST http://127.0.0.1:${port}`), /exited with code [1-9]/);
    assert.equal(await run(`curl --silent --max-time 2 --output /dev/null --write-out '%{http_code}' --noproxy '' --proxy "$HTTP_PROXY" -X POST http://127.0.0.1:${port}`), "403");
    const connect = `const s=require('node:net').connect(${JSON.stringify(socketPath)});s.on('error',()=>process.exit(17));`;
    assert.match(await run(`${shellQuote(process.execPath)} -e ${shellQuote(connect)}`), /exited with code [1-9]/);
    assert.equal(requests, 0); assert.equal(await readFile(outside, "utf8"), "untouched");
  } finally { await Promise.all([new Promise<void>(resolve => http.close(() => resolve())), new Promise<void>(resolve => unix.close(() => resolve()))]); await rm(root, { recursive: true, force: true }); }
});
test("the same native entry reads related files, blocks shared credentials and cannot write related files", async () => {
  const state = await mkdtemp(path.join(tmpdir(), "issue-pilot-related-boundary-")), own = path.join(state, "workspaces", "issue-20261022-001"), related = path.join(state, "workspaces", "issue-20261022-002");
  await mkdir(own, { recursive: true }); await mkdir(related, { recursive: true });
  await writeFile(path.join(related, "report.txt"), "related evidence"); await writeFile(path.join(state, "private-settings.json"), "fixture-private-credential");
  await symlink(related, path.join(own, ".related-issue-20261022-002"));
  try {
    const tools = issueNativeTools({ writeRoot: own, readRoots: [related] });
    const invoke = (name: string, input: unknown) => tools.find(tool => tool.name === name)!.execute("boundary", input as never, undefined, undefined, {} as never);
    const read = await invoke("read", { path: ".related-issue-20261022-002/report.txt" });
    assert.match(JSON.stringify(read), /related evidence/);
    await assert.rejects(invoke("read", { path: path.join(state, "private-settings.json") }));
    const result = await invoke("bash", { command: `printf forbidden > ${shellQuote(path.join(related, "report.txt"))}` });
    assert.match(JSON.stringify(result), /exited with code|denied|Read-only|not found/i);
    assert.equal(await readFile(path.join(related, "report.txt"), "utf8"), "related evidence");
  } finally { await rm(state, { recursive: true, force: true }); }
});
test("a configured raw TCP MCP client uses the authenticated proxy even without proxy-aware client code", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-raw-tcp-")); let connections = 0;
  const server = createUnixServer(socket => { connections++; socket.end("mysql fixture greeting"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.2", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const code = `require('node:net').connect(${port},'127.0.0.2').on('data',chunk=>process.stdout.write(chunk)).on('error',()=>{process.exitCode=9})`;
    const command = await prepareIssueCommand({ writeRoot: root, networkDomains: [`127.0.0.2:${port}`] }, [process.execPath, "-e", code]);
    try {
      const [executable, ...args] = command.argv;
      const result = await executeLocalCommand(executable!, args, { cwd: root, timeout: 5000 });
      assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout, "mysql fixture greeting"); assert.equal(connections, 1);
    } finally { await command.cleanup(); }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test("stdio PATH overrides cannot replace the trusted sandbox executables", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-sandbox-path-")), own = path.join(root, "own"), bin = path.join(own, "bin"), escaped = path.join(root, "escaped.txt");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "bwrap"), `#!/bin/sh\nprintf escaped > ${shellQuote(escaped)}\n`, { mode: 0o700 });
  try {
    const command = await prepareIssueCommand({ writeRoot: own }, [process.execPath, "-e", "process.stdout.write('sandboxed')"]);
    try {
      const [executable, ...args] = command.argv;
      const result = await executeLocalCommand(executable!, args, { cwd: own, environment: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME ?? "" } });
      assert.equal(result.code, 0); assert.equal(result.stdout, "sandboxed");
      await assert.rejects(readFile(escaped), { code: "ENOENT" });
    } finally { await command.cleanup(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("standard npm and mvn commands run without a command broker or generated wrappers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-standard-project-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"require('node:fs').writeFileSync('passed.txt','passed')\"" } }));
    const bash = issueNativeTools({ writeRoot: root }).find(tool => tool.name === "bash")!;
    await bash.execute("npm", { command: "npm test", timeout: 15 }, undefined, undefined, {} as never);
    assert.equal(await readFile(path.join(root, "passed.txt"), "utf8"), "passed");
    const maven = await bash.execute("mvn", { command: "mvn --version", timeout: 15 }, undefined, undefined, {} as never);
    assert.match(JSON.stringify(maven), /Apache Maven/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
