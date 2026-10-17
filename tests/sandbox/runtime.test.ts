import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { executeLocalCommand, type CommandExecutor, type CommandExecutionOptions } from "../../src/process.ts";
import { PodmanSandbox } from "../../src/sandbox/runtime.ts";

const ok = { stdout: "", stderr: "", code: 0, killed: false };
const calls: Array<{ args: string[]; options?: CommandExecutionOptions }> = [];
const fake: CommandExecutor = { async execute(_command, args, options) { calls.push({ args, ...(options ? { options } : {}) }); return ok; } };

test("sandbox uses bounded, mount-free container argv, closes on interruption and releases capacity", { skip: process.platform !== "linux" || process.getuid?.() === 0 }, async () => {
  const first = await PodmanSandbox.open(undefined, fake);
  const second = await PodmanSandbox.open(undefined, fake);
  try {
    await assert.rejects(PodmanSandbox.open(undefined, fake), /sandbox_capacity_exceeded/);
    const args = calls[0]!.args;
    assert.equal(args[args.indexOf("--network") + 1], "none");
    assert.ok(args.includes("--http-proxy=false"));
    assert.ok(args.includes("--read-only"));
    assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
    assert.equal(args[args.indexOf("--timeout") + 1], String(issuePilotConfig.limits.sandbox.lifetimeSeconds));
    assert.ok(!args.some(arg => ["--volume", "--mount", "--privileged", "--env-host", "--network=host"].includes(arg)));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(first.execute("echo denied", controller.signal), /sandbox_aborted/);
    assert.ok(first.closed);
    const replacement = await PodmanSandbox.open(undefined, fake);
    await replacement.close();
    await second.importFile("binary.dat", Buffer.from([0, 255, 1]));
    const imported = calls.find(call => call.options?.input);
    assert.deepEqual(imported?.options?.input, Buffer.from([0, 255, 1]));
    assert.ok(!JSON.stringify(imported?.args).includes("255,1"));
    assert.ok(calls.some(call => call.args[0] === "rm" && call.args.includes(first.name)));
  } finally { await first.close(); await second.close(); }
});

test("failed startup cleanup retains a retry owner and does not permanently leak a capacity slot", { skip: process.platform !== "linux" || process.getuid?.() === 0 }, async () => {
  let removals = 0;
  const failing: CommandExecutor = { async execute(_command, args) {
    if (args[0] === "run") return { ...ok, code: 1 };
    if (++removals === 1) return { ...ok, code: 1 };
    return ok;
  } };
  await assert.rejects(PodmanSandbox.open(undefined, failing), /sandbox_cleanup_failed/);
  await PodmanSandbox.cleanupPending();
  assert.equal(removals, 2);
  const first = await PodmanSandbox.open(undefined, fake), second = await PodmanSandbox.open(undefined, fake);
  await first.close(); await second.close();
});

const available = process.platform === "linux" && process.getuid?.() !== 0 && await executeLocalCommand("podman", ["image", "exists", issuePilotConfig.runtime.sandbox.image], { timeout: 5000 }).then(result => !result.code, () => false);
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test("real containers isolate host state and each other and round-trip binary files without symlink or oversized exports", { skip: !available && "requires rootless Podman and the configured local sandbox image" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-sandbox-runtime-"));
  const canary = join(root, "private-canary");
  await writeFile(canary, "synthetic host secret");
  const priorProxy = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = "http://fixture:fake-secret@127.0.0.1:9";
  let first: PodmanSandbox | undefined, second: PodmanSandbox | undefined;
  try {
    first = await PodmanSandbox.open(); second = await PodmanSandbox.open();
    const source = `
const fs=require('node:fs'), assert=require('node:assert/strict');
assert.notEqual(process.getuid(),0);
assert.equal(fs.existsSync(${JSON.stringify(canary)}),false);
assert.equal(fs.existsSync('/var/run/docker.sock'),false);
assert.equal(process.env.HTTP_PROXY,undefined);
assert.equal(process.env.http_proxy,undefined);
assert.deepEqual(fs.readdirSync('/sys/class/net'),['lo']);
assert.throws(()=>fs.writeFileSync('/etc/forbidden','no'));
const status=fs.readFileSync('/proc/self/status','utf8');
assert.match(status,/NoNewPrivs:\\s+1/); assert.match(status,/Seccomp:\\s+2/); assert.match(status,/CapEff:\\s+0000000000000000/);
fs.writeFileSync('/work/owned.txt','first');
console.log('verified');`;
    const checked = await first.execute(`node -e ${shellQuote(source)}`);
    assert.equal(checked.code, 0, checked.stderr); assert.match(checked.stdout, /verified/);
    assert.equal((await second.execute("test -e /work/owned.txt")).code, 1);
    const content = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    await first.importFile("binary.dat", content);
    assert.deepEqual(await first.exportFile("binary.dat"), content);
    await assert.rejects(first.importFile("binary.dat", Buffer.from("replacement")), /sandbox_import_failed/);
    assert.deepEqual(await first.exportFile("binary.dat"), content);
    await assert.rejects(first.exportFile("../private-canary"), /invalid_output_file_name/);
    assert.equal((await first.execute("ln -s /etc/hostname link.txt && mkfifo fifo")).code, 0);
    await assert.rejects(first.exportFile("link.txt"), /sandbox_export_failed/);
    await assert.rejects(first.exportFile("fifo"), /sandbox_export_failed/);
    await first.execute(`truncate -s ${issuePilotConfig.limits.sandbox.transferBytes + 1} too-large.dat`);
    await assert.rejects(first.exportFile("too-large.dat"), /sandbox_export_failed/);
  } finally {
    await Promise.all([first?.close(), second?.close()]);
    if (priorProxy === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = priorProxy;
    await rm(root, { recursive: true, force: true });
  }
});

test("real cancellation removes the whole container with background descendants", { skip: !available && "requires rootless Podman and the configured local sandbox image" }, async () => {
  const sandbox = await PodmanSandbox.open();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    await assert.rejects(sandbox.execute("node -e \"require('child_process').spawn('node',['-e','setInterval(()=>{},1000)']);setInterval(()=>{},1000)\"", controller.signal), /sandbox_aborted/);
    assert.equal((await executeLocalCommand("podman", ["container", "exists", sandbox.name])).code, 1);
    assert.ok(sandbox.closed);
    await sandbox.close();
  } finally { clearTimeout(timer); await sandbox.close(); }
});
