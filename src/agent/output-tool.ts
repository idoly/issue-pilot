import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { capabilityResultText, capabilityTextResult } from "../capabilities/contracts.ts";
import { generateSpreadsheet, type SpreadsheetAttachment } from "../outputs/spreadsheet.ts";
import { IssueOutputStore } from "../outputs/store.ts";

const outputInputSchema = Type.Union([
  Type.Object({ operation: Type.Literal("list") }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("write"), fileName: Type.String({ minLength: 1, maxLength: 255 }), content: Type.String() }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("append"), fileName: Type.String({ minLength: 1, maxLength: 255 }), content: Type.String() }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("spreadsheet"), fileName: Type.String({ minLength: 1, maxLength: 255, description: "Output .xlsx file name" }), attachmentIds: Type.Array(Type.String(), { uniqueItems: true, description: "IDs of this Issue's Excel attachments; use list to discover them" }), outputFiles: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 255 }), { uniqueItems: true, description: "Existing output file names in this Issue only: JSON/JSONL, CSV/TSV, XLS/XLSX. DMS exports are JSON with {tool,result}; text content inside result may itself be JSON." })), data: Type.Optional(Type.Unknown({ description: "Optional structured data available as the data variable" })), script: Type.String({ description: "JavaScript function body. files is an array of {id?,fileName,source,sheets?:[{name,rows:string[][]}],data?:unknown}. Excel/CSV have sheets; JSON/JSONL have data. Process all rows using JS arrays, Map, Set, etc. Return {sheets:[{name,rows:(string|number|boolean|null)[][]}]}. No filesystem, network, Node.js, or process APIs. Example: return {sheets: files[0].sheets};" }) }, { additionalProperties: false }),
]);

type OutputInput = Static<typeof outputInputSchema>;

export function createOutputTool(store: IssueOutputStore, spreadsheet?: { attachmentRoot: string; attachments: SpreadsheetAttachment[] }): ToolDefinition<any, any, any> {
  return defineTool({
    name: "output",
    label: "Write Issue Output",
    description: "Create, append, or list durable output files. Use operation spreadsheet to batch-process this Issue's Excel attachments, existing query-result output files, and supplied data in isolated JavaScript and generate a real .xlsx. Repositories remain read-only.",
    promptSnippet: "Batch-process Excel attachments and generate XLSX, or write SQL, CSV, JSON, JSONL, text, Markdown results",
    promptGuidelines: [
      "Use output for user-deliverable files only; repository snapshots remain read-only.",
      "Use append for chunked large results and report each generated file name in the final answer.",
    ],
    parameters: outputInputSchema,
    execute: async (_id, rawInput, signal): Promise<AgentToolResult<unknown>> => {
      let input: OutputInput;
      try { input = Value.Parse(outputInputSchema, rawInput ?? {}); }
      catch { throw new Error("invalid_output_input"); }
      if (input.operation === "list") {
        const outputs = await store.list();
        return capabilityTextResult(capabilityResultText({ outputs, attachments: spreadsheet?.attachments.map(({ id, fileName, size }) => ({ id, fileName, size })) ?? [] }), { operation: "list", files: outputs.length });
      }
      if (input.operation === "spreadsheet") {
        if (!spreadsheet) throw new Error("spreadsheet_attachments_unavailable");
        const output = await generateSpreadsheet(store, spreadsheet.attachmentRoot, spreadsheet.attachments, input, signal);
        return capabilityTextResult(capabilityResultText({ output }), { operation: "spreadsheet", fileName: output.fileName, size: output.size });
      }
      const output = input.operation === "write"
        ? await store.write(input.fileName, input.content)
        : await store.append(input.fileName, input.content);
      return capabilityTextResult(capabilityResultText({ output }), { operation: input.operation, fileName: output.fileName, size: output.size });
    },
  });
}
