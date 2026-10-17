import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { executeLocalCommand } from "../../src/process.ts";
import { ExperimentSandbox, sandboxImage, sandboxLimits } from "./sandbox.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function verifySandbox(evidence: string, privateRoot: string) {
  const canary = join(privateRoot, "host-private.txt");
  const sibling = join(privateRoot, "other-issue");
  await mkdir(sibling);
  await writeFile(canary, "synthetic private canary");
  await writeFile(join(sibling, "private.txt"), "other issue canary");
  const before = await readFile(join(evidence, "config.json"), "utf8");
  const previousCanary = process.env.ISSUE_PILOT_EXPERIMENT_CANARY;
  process.env.ISSUE_PILOT_EXPERIMENT_CANARY = "synthetic-host-only-value";
  const sandbox = await ExperimentSandbox.open(evidence);
  const checks: string[] = [];
  try {
    const script = `
      const fs = require('node:fs');
      const assert = require('node:assert/strict');
      assert.notEqual(process.getuid(), 0);
      for (const path of ${JSON.stringify([canary, join(sibling, "private.txt"), "/var/run/docker.sock", "/run/podman/podman.sock"])}) assert.equal(fs.existsSync(path), false);
      assert.equal(process.env.ISSUE_PILOT_EXPERIMENT_CANARY, undefined);
      assert.throws(() => fs.writeFileSync('/evidence/config.json', 'changed'));
      assert.throws(() => fs.writeFileSync('/etc/experiment-file', 'changed'));
      assert.equal(fs.readFileSync('/proc/self/status', 'utf8').match(/^NoNewPrivs:\\s+(\\d+)/m)[1], '1');
      assert.equal(fs.readFileSync('/proc/self/status', 'utf8').match(/^Seccomp:\\s+(\\d+)/m)[1], '2');
      assert.equal(fs.readFileSync('/proc/self/status', 'utf8').match(/^CapEff:\\s+(\\w+)/m)[1], '0000000000000000');
      assert.deepEqual(fs.readdirSync('/sys/class/net'), ['lo']);
      fs.writeFileSync('/work/result.txt', 'allowed');
      assert.equal(fs.readFileSync('/work/result.txt', 'utf8'), 'allowed');
      console.log('isolation verified');
    `;
    const result = await sandbox.execute(`node -e ${quote(script)}`);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /isolation verified/);
    assert.equal(await readFile(join(evidence, "config.json"), "utf8"), before);
    checks.push("non-root", "host-and-other-issue-unmounted", "no-engine-socket", "no-host-env", "evidence-read-only", "root-read-only", "no-new-privileges", "seccomp-filter-enabled", "capabilities-dropped", "network-loopback-only", "workspace-writable");
    const inspection = await executeLocalCommand("podman", ["inspect", "--format", "{{json .HostConfig}}", sandbox.name]);
    const config = JSON.parse(inspection.stdout);
    assert.equal(config.Memory, 512 * 1024 * 1024);
    assert.equal(config.PidsLimit, 64);
    assert.ok(config.SecurityOpt.some((value: string) => value.includes("no-new-privileges")));
    checks.push("memory-and-pid-limits-configured");
  } finally {
    await sandbox.close();
    if (previousCanary === undefined) delete process.env.ISSUE_PILOT_EXPERIMENT_CANARY;
    else process.env.ISSUE_PILOT_EXPERIMENT_CANARY = previousCanary;
  }
  for (const mode of ["pre-abort", "abort", "timeout", "output"] as const) {
    const running = await ExperimentSandbox.open(evidence);
    try {
      const controller = new AbortController();
      if (mode === "pre-abort") controller.abort();
      const timer = mode === "abort" ? setTimeout(() => controller.abort(), 300) : undefined;
      try {
        const source = mode === "output" ? "process.stdout.write('x'.repeat(300000))" : "require('node:child_process').spawn('node',['-e','setInterval(()=>{},1000)']);setInterval(()=>{},1000)";
        await assert.rejects(running.execute(`node -e ${quote(source)}`, controller.signal, mode === "timeout" ? 300 : 30_000), mode === "output" ? /command_output_too_large/ : new RegExp(`sandbox_${mode === "abort" || mode === "pre-abort" ? "aborted" : "timeout"}`));
      } finally { if (timer) clearTimeout(timer); }
      const exists = await executeLocalCommand("podman", ["container", "exists", running.name]);
      assert.equal(exists.code, 1);
      checks.push(`${mode}-removes-container-and-descendants`);
    } finally { await running.close(); }
  }
  return checks;
}

export async function benchmarkSandbox(evidence: string, repeats = 10) {
  const source = "const a=require('/evidence/orders.json');console.log(a.filter(x=>x.status==='paid').reduce((s,x)=>s+x.cents,0))";
  const localEvidence = join(evidence, "orders.json");
  const localSource = source.replace("/evidence/orders.json", localEvidence);
  // Host control executes this fixed, repository-owned program only; never model code.
  const metadata = await executeLocalCommand("podman", ["image", "inspect", "--format", "{{.Id}}", sandboxImage]);
  assert.equal(metadata.code, 0);
  const started = performance.now();
  const sandbox = await ExperimentSandbox.open(evidence);
  const startupMs = performance.now() - started;
  const host: number[] = [], container: number[] = [];
  let containerNode = "";
  try {
    const version = await sandbox.execute("node --version");
    assert.equal(version.code, 0);
    containerNode = version.stdout.trim();
    for (let i = 0; i < repeats; i++) {
      for (const placement of i % 2 ? ["container", "host"] : ["host", "container"]) {
        const start = performance.now();
        const result = placement === "host"
          ? await executeLocalCommand(process.execPath, ["-e", localSource], { timeout: 30_000 })
          : await sandbox.execute(`node -e ${quote(source)}`);
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /^\d+\n$/);
        (placement === "host" ? host : container).push(performance.now() - start);
      }
    }
  } finally { await sandbox.close(); }
  const summarize = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { samples: values.length, medianMs: (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2, p95Ms: sorted[Math.ceil(sorted.length * .95) - 1]!, valuesMs: values };
  };
  return { image: sandboxImage, imageId: metadata.stdout.trim(), hostNode: process.version, containerNode, limits: sandboxLimits, startupMs, host: summarize(host), container: summarize(container) };
}
