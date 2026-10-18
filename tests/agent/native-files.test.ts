import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { utils, write } from "@e965/xlsx";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiSessionRuntime, createPrivateSessionManager } from "../../src/agent/pi-session.ts";
import { IssueOutputStore } from "../../src/outputs/store.ts";
import { parseExcel } from "../../src/documents/excel.ts";

test("native tools process files with installed libraries and publish arbitrary formats", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-native-files-"));
  const work = join(root, "work");
  await mkdir(work);
  await mkdir(join(root, "sessions"));
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([["id", "amount"], ["synthetic-private-row", 42]]), "input");
  await writeFile(join(root, "input.xlsx"), write(workbook, { type: "buffer", bookType: "xlsx" }));
  const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
  const faux = fauxProvider({ provider: "native-files-fixture", models: [{ id: "fixture", contextWindow: 64000 }], tokensPerSecond: 100000 });
  models.registerNativeProvider(faux.provider);
  const runtime = new PiSessionRuntime({ load: async () => models, close: async () => {} });
  const manager = await createPrivateSessionManager(work, join(root, "sessions"));
  const outputs = new IssueOutputStore(root, "ISSUE-20261017-001");
  const call = (name: string, input: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, input), { stopReason: "toolUse" });
  faux.setResponses([
    call("write", { path: "process.cjs", content: `const fs=require('node:fs'), xlsx=require('@e965/xlsx');
const book=xlsx.readFile('../input.xlsx');
xlsx.writeFile(book, 'delivery.xlsx');
fs.writeFileSync('opaque.bin',Buffer.from([0,255,1,2]));
console.log('files generated');` }),
    call("bash", { command: "node process.cjs" }),
    call("output", { operation: "publish", sourcePath: "delivery.xlsx", fileName: "delivery.xlsx" }),
    call("output", { operation: "publish", sourcePath: "opaque.bin", fileName: "opaque.bin" }),
    transcript => { assert.ok(!JSON.stringify(transcript).includes("synthetic-private-row")); return fauxAssistantMessage("Delivered files."); },
    call("edit", { path: "process.cjs", oldText: "files generated", newText: "files regenerated" }),
    call("bash", { command: "node process.cjs" }),
    fauxAssistantMessage("Working files retained."),
  ]);
  let managed;
  try {
    managed = await runtime.start({ manager, context: { issueKey: "ISSUE-20261017-001", serviceKey: "fixture", environmentKey: "prod", model: { provider: "native-files-fixture", modelId: "fixture", thinkingLevel: "off" }, codemode: "off", capabilities: [], canModifyCode: false, canWriteOutputs: true }, deploymentConfig: {}, workspaceRoot: work, outputStore: outputs, systemPrompt: "Process files with native tools and publish them.", onEvent: () => {} });
    assert.deepEqual(managed.session.getActiveToolNames().sort(), ["bash", "edit", "find", "grep", "ls", "output", "read", "write"]);
    await managed.prompt("Process the workbook and publish both files.");
    assert.deepEqual(parseExcel(await outputs.read("delivery.xlsx"))[0]!.rows[1], ["synthetic-private-row", "42"]);
    assert.deepEqual(await outputs.read("opaque.bin"), Buffer.from([0, 255, 1, 2]));
    assert.equal(managed.session.getLastAssistantText(), "Delivered files.");
    assert.ok(!(await readFile(manager.getSessionFile()!, "utf8")).includes("synthetic-private-row"));
    await managed.prompt("Reuse and edit the existing script.");
    assert.equal(managed.session.getLastAssistantText(), "Working files retained.");
    assert.equal(faux.getPendingResponseCount(), 0);
    await managed.stop(); await managed.stop();
  } finally { await managed?.stop(); await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
