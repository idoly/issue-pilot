import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { utils, write } from "@e965/xlsx";
import { generateSpreadsheet } from "../../src/outputs/spreadsheet.ts";
import { IssueOutputStore } from "../../src/outputs/store.ts";
import { parseExcel } from "../../src/documents/excel.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-spreadsheet-"));
  const attachmentRoot = path.join(root, "issues", "issue-20261016-004", "attachments");
  await mkdir(attachmentRoot, { recursive: true, mode: 0o700 });
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([["id", "amount"], ...Array.from({ length: 13882 }, (_, i) => [String(i).padStart(6, "0"), i])]), "data");
  const data = write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const objectKey = path.join(attachmentRoot, "input.xlsx");
  await writeFile(objectKey, data, { mode: 0o400 });
  const attachments = [{ id: "input-id", fileName: "input.xlsx", objectKey, size: data.length, sha256: createHash("sha256").update(data).digest("hex") }];
  const store = new IssueOutputStore(root, "ISSUE-20261016-004");
  return { root, attachmentRoot, attachments, store, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("bounds concurrent spreadsheet workers without queueing additional executions", async () => {
  const f = await fixture();
  try {
    const runs = Array.from({ length: issuePilotConfig.limits.spreadsheet.workers + 1 }, (_, index) => generateSpreadsheet(f.store, f.attachmentRoot, [], { fileName: `parallel-${index}.xlsx`, attachmentIds: [], script: 'const until=Date.now()+500; while(Date.now()<until){}; return {sheets:[{name:"result",rows:[["ok"]]}]};' }));
    const results = await Promise.allSettled(runs);
    assert.equal(results.filter(result => result.status === "fulfilled").length, issuePilotConfig.limits.spreadsheet.workers);
    const rejected = results.filter(result => result.status === "rejected");
    assert.equal(rejected.length, 1);
    assert.match(String(rejected[0]!.reason), /spreadsheet_capacity_exceeded/);
    assert.equal((await f.store.list()).length, issuePilotConfig.limits.spreadsheet.workers);
  } finally { await f.cleanup(); }
});

test("processes all attachment rows in isolation and publishes a real XLSX without returning rows to the model", async () => {
  const f = await fixture();
  try {
    const result = await generateSpreadsheet(f.store, f.attachmentRoot, f.attachments, { fileName: "delivery.xlsx", attachmentIds: ["input-id"], script: 'const rows = files[0].sheets[0].rows; return {sheets:[{name:"全量",rows:rows.map((row,i)=>i ? [row[0], Number(row[1])*2] : row)},{name:"校验",rows:[["总条数",rows.length-1],["process",typeof process],["require",typeof require],["fetch",typeof fetch]]}]};' });
    assert.deepEqual(result.sheets, [{ name: "全量", rows: 13883 }, { name: "校验", rows: 4 }]);
    assert.equal("rows" in result, false);
    const outputs = await f.store.list();
    const file = path.join(f.root, "issues", "issue-20261016-004", "outputs", outputs[0]!.fileName);
    const sheets = parseExcel(await readFile(file));
    assert.equal(sheets[0]!.rows[1]![0], "000000");
    assert.equal(sheets[0]!.rows[13882]![1], String(13881 * 2));
    assert.deepEqual(sheets[1]!.rows.slice(1).map((row) => row[1]), ["undefined", "undefined", "undefined"]);
  } finally { await f.cleanup(); }
});

test("joins persisted DMS JSON, CSV, and supplied data into an XLSX without echoing query rows", async () => {
  const f = await fixture();
  try {
    await f.store.write("dms-batch-001.json", JSON.stringify({ tool: "executeScript", result: { content: [{ type: "text", text: JSON.stringify({ rows: [{ id: "000001", owner: "张三" }, { id: "000002", owner: "李四" }] }) }] } }));
    await f.store.write("input.csv", 'id,amount\n000001,10\n000002,20\n');
    const result = await generateSpreadsheet(f.store, f.attachmentRoot, f.attachments, {
      fileName: "joined.xlsx", attachmentIds: [], outputFiles: ["dms-batch-001.json", "input.csv"], data: { factor: 3 },
      script: 'const lookup = new Map(JSON.parse(files[0].data.result.content[0].text).rows.map(r=>[r.id,r.owner])); return {sheets:[{name:"交付",rows:[["id","姓名","金额"],...files[1].sheets[0].rows.slice(1).map(r=>[r[0],lookup.get(r[0]),Number(r[1])*data.factor])]}]};',
    });
    assert.deepEqual(result.sheets, [{ name: "交付", rows: 3 }]);
    const sheets = parseExcel(await f.store.read("joined.xlsx"));
    assert.deepEqual(sheets[0]!.rows[1], ["000001", "张三", "30"]);
    assert.deepEqual(sheets[0]!.rows[2], ["000002", "李四", "60"]);
    await assert.rejects(generateSpreadsheet(f.store, f.attachmentRoot, f.attachments, { fileName: "bad.xlsx", attachmentIds: [], outputFiles: ["../other-issue.json"], script: 'return {sheets:[]}' }), /invalid_output_file_name/);
  } finally { await f.cleanup(); }
});

test("cancels an active CPU script while the host timer remains responsive and preserves the previous file", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let timerRan = false;
  const timer = setTimeout(() => { timerRan = true; controller.abort(new Error("cancelled_during_script")); }, 100);
  try {
    await f.store.write("delivery.xlsx", "previous");
    await assert.rejects(generateSpreadsheet(f.store, f.attachmentRoot, [], { fileName: "delivery.xlsx", attachmentIds: [], script: 'const until=Date.now()+1000; while(Date.now()<until){}; return {sheets:[{name:"late",rows:[["must not publish"]]}]};' }, controller.signal), /cancelled_during_script/);
    assert.equal(timerRan, true);
    assert.equal((await f.store.read("delivery.xlsx")).toString(), "previous");
  } finally { clearTimeout(timer); await f.cleanup(); }
});

test("passes large authorized input through the SDK bridge and validates the returned workbook", async () => {
  const f = await fixture();
  try {
    const length = 2 * 1024 * 1024;
    await generateSpreadsheet(f.store, f.attachmentRoot, [], { fileName: "large.xlsx", attachmentIds: [], data: { text: "a".repeat(length) }, script: 'return {sheets:[{name:"summary",rows:[[data.text.length]]}]};' });
    assert.equal(parseExcel(await f.store.read("large.xlsx"))[0]!.rows[0]![0], String(length));
    await assert.rejects(generateSpreadsheet(f.store, f.attachmentRoot, [], { fileName: "invalid.xlsx", attachmentIds: [], script: 'return {sheets:[{name:"bad",rows:[[{}]]}]};' }), /spreadsheet_invalid_result/);
    assert.equal((await f.store.list()).length, 1);
  } finally { await f.cleanup(); }
});

test("enforces VM memory and wall time budgets without publishing partial files", { timeout: 40_000 }, async () => {
  const f = await fixture();
  try {
    await f.store.write("delivery.xlsx", "previous");
    await assert.rejects(generateSpreadsheet(f.store, f.attachmentRoot, [], { fileName: "delivery.xlsx", attachmentIds: [], script: 'return {sheets:[{name:"oversized",rows:[["x".repeat(300*1024*1024)]]}]};' }), /spreadsheet_script_failed|spreadsheet_execution_unavailable/);
    await assert.rejects(generateSpreadsheet(f.store, f.attachmentRoot, [], { fileName: "delivery.xlsx", attachmentIds: [], script: 'while(true){}' }), /spreadsheet_execution_timeout/);
    assert.equal((await f.store.read("delivery.xlsx")).toString(), "previous");
    assert.equal((await f.store.list()).length, 1);
  } finally { await f.cleanup(); }
});

test("rejects unauthorized files, script failure, and abort without changing published outputs", async () => {
  const f = await fixture();
  try {
    await f.store.write("delivery.xlsx", "preserve");
    const input = { fileName: "delivery.xlsx", attachmentIds: ["input-id"], script: 'throw new Error("private-content")' };
    await assert.rejects(generateSpreadsheet(f.store, f.attachmentRoot, f.attachments, { ...input, attachmentIds: ["another-issue-id"] }), /spreadsheet_attachment_not_authorized/);
    await assert.rejects(generateSpreadsheet(f.store, f.attachmentRoot, f.attachments, input), /spreadsheet_script_failed/);
    await assert.rejects(generateSpreadsheet(f.store, f.attachmentRoot, f.attachments, input, AbortSignal.abort(new Error("cancelled"))), /cancelled/);
    const outputRoot = path.join(f.root, "issues", "issue-20261016-004", "outputs");
    assert.deepEqual(await readdir(outputRoot), ["delivery.xlsx"]);
    assert.equal(await readFile(path.join(outputRoot, "delivery.xlsx"), "utf8"), "preserve");
  } finally { await f.cleanup(); }
});
