import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { test } from "node:test";

import type { CommandExecutionOptions, CommandExecutor } from "../src/capabilities/local-exec.ts";
import { ProcessToolRuntime } from "../src/tool-runtime.ts";

const result = { stdout: "ok", stderr: "", code: 0, killed: false };

test("runs fixed tools from the application process environment", async () => {
  let call: { command: string; args: string[]; options?: CommandExecutionOptions } | undefined;
  let temporaryHome = "";
  const executor: CommandExecutor = {
    async execute(command, args, options) {
      call = { command, args, ...(options ? { options } : {}) };
      temporaryHome = options!.environment!.HOME!;
      await access(temporaryHome);
      return result;
    },
  };
  const runtime = new ProcessToolRuntime(executor);
  assert.equal((await runtime.run({ command: ["npm", "run", "test"], cwd: "/workspace", environment: { CI: "1" } })).stdout, "ok");
  assert.deepEqual({ command: call!.command, args: call!.args, cwd: call!.options!.cwd, ci: call!.options!.environment!.CI }, {
    command: "npm", args: ["run", "test"], cwd: "/workspace", ci: "1",
  });
  await assert.rejects(access(temporaryHome), { code: "ENOENT" });
});

test("allows only npm, Maven, and scoped Aliyun commands", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runtime = new ProcessToolRuntime({
    async execute(command, args) {
      calls.push({ command, args });
      return result;
    },
  });
  await runtime.run({ command: ["mvn", "--version"] });
  await runtime.run({ command: ["aliyun", "sls", "GetLogs"] });
  assert.deepEqual(calls, [
    { command: "mvn", args: ["--version"] },
    { command: "aliyun", args: ["sls", "GetLogs"] },
  ]);
  await assert.rejects(runtime.run({ command: ["node", "--version"] }), /tool_command_not_allowed/);
  await assert.rejects(runtime.run({ command: ["aliyun", "ecs", "DescribeInstances"] }), /tool_command_not_allowed/);
});

test("rejects invalid process tool requests", async () => {
  const runtime = new ProcessToolRuntime({ execute: async () => result });
  await assert.rejects(runtime.run({ command: ["npm"], cwd: "relative" }), /invalid_tool_configuration/);
  await assert.rejects(runtime.run({ command: ["npm"], environment: { "BAD-NAME": "value" } }), /invalid_tool_configuration/);
  await assert.rejects(runtime.run({ command: ["npm", "bad\0argument"] }), /invalid_tool_configuration/);
});
