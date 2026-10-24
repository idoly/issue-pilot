import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiSessionRuntime, createPrivateSessionManager } from "../../src/agent/pi-session.ts";

const execFileAsync = promisify(execFile);
const python = fileURLToPath(new URL("../../.venv/bin/python3", import.meta.url));

test("native tools read a readonly attachment original directly and explicitly save an edited workbook", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-native-files-"));
  let managed;
  let runtime: PiSessionRuntime | undefined;
  try {
    const work = root;
    await execFileAsync(python, ["-c", `from openpyxl import Workbook
import sys
book = Workbook()
sheet = book.active
sheet.title = 'input'
sheet.append(['id', 'amount'])
sheet.append(['synthetic-private-row', 42])
sheet.append(['00123', 8])
book.save(sys.argv[1])`, join(root, ".attachment-fixture-input.xlsx")]);
    await chmod(join(root, ".attachment-fixture-input.xlsx"), 0o400);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
    const faux = fauxProvider({ provider: "native-files-fixture", models: [{ id: "fixture", contextWindow: 64000 }], tokensPerSecond: 100000 });
    models.registerNativeProvider(faux.provider);
    runtime = new PiSessionRuntime({ load: async () => models, close: async () => {} });
    const manager = await createPrivateSessionManager(work, root);
    const call = (name: string, input: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, input), { stopReason: "toolUse" });
    faux.setResponses([
      call("write", { path: "process.py", content: `from pathlib import Path
from openpyxl import load_workbook
book = load_workbook('.attachment-fixture-input.xlsx')
book['input']['B2'].value *= 2
book['input']['B2'].number_format = '0.00'
summary = book.create_sheet('汇总')
summary.append(['Total', '=SUM(input!B2:B3)'])
book.save('delivery.xlsx')
book.close()
Path('opaque.bin').write_bytes(bytes([0, 255, 1, 2]))
print('files generated')` }),
      call("bash", { command: "python3 -m pip --version && pip --version && python3 process.py" }),
      transcript => { assert.ok(!JSON.stringify(transcript).includes("synthetic-private-row")); return fauxAssistantMessage("Delivered files."); },
      call("edit", { path: "process.py", oldText: "files generated", newText: "files regenerated" }),
      call("bash", { command: "python3 process.py" }),
      fauxAssistantMessage("Working files retained."),
    ]);
    const failures: unknown[] = [];
    managed = await runtime.start({ manager, context: { issueKey: "ISSUE-20261017-001", serviceKey: "fixture", environmentKey: "prod", model: { provider: "native-files-fixture", modelId: "fixture", thinkingLevel: "off" }, codemode: "off", capabilities: [], canModifyCode: false }, deploymentConfig: {}, workspaceRoot: work, systemPrompt: "Process files in this working directory.", onEvent: (event) => { if (event.type === "tool_execution_end" && event.isError) failures.push(event.result); } });
    assert.deepEqual(managed.session.getActiveToolNames().sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
    await managed.prompt("Process the workbook and retain both files in the working directory.");
    assert.deepEqual(failures, []);
    const checked = await execFileAsync(python, ["-c", `import json, sys
from openpyxl import load_workbook
book = load_workbook(sys.argv[1])
original = load_workbook(sys.argv[2])
print(json.dumps({'sheets': book.sheetnames, 'row': [cell.value for cell in book['input'][2]], 'identifier': book['input']['A3'].value, 'format': book['input']['B2'].number_format, 'formula': book['汇总']['B1'].value, 'original': original['input']['B2'].value}))
book.close()
original.close()`, join(work, "delivery.xlsx"), join(root, ".attachment-fixture-input.xlsx")]);
    assert.deepEqual(JSON.parse(checked.stdout), { sheets: ["input", "汇总"], row: ["synthetic-private-row", 84], identifier: "00123", format: "0.00", formula: "=SUM(input!B2:B3)", original: 42 });
    assert.equal((await stat(join(root, ".attachment-fixture-input.xlsx"))).mode & 0o7777, 0o400);
    assert.deepEqual(await readFile(join(work, "opaque.bin")), Buffer.from([0, 255, 1, 2]));
    assert.equal(managed.session.getLastAssistantText(), "Delivered files.");
    assert.ok(!(await readFile(manager.getSessionFile()!, "utf8")).includes("synthetic-private-row"));
    await managed.prompt("Reuse and edit the existing script.");
    assert.equal(managed.session.getLastAssistantText(), "Working files retained.");
    assert.deepEqual(failures, []);
    assert.equal(faux.getPendingResponseCount(), 0);
    await managed.stop(); await managed.stop();
  } finally { await managed?.stop(); await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});
