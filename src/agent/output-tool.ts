import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { capabilityResultText, capabilityTextResult } from "../capabilities/contracts.ts";
import { IssueOutputStore } from "../outputs/store.ts";

const outputInputSchema = Type.Union([
  Type.Object({ operation: Type.Literal("list") }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("write"), fileName: Type.String({ minLength: 1, maxLength: 255 }), content: Type.String() }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("append"), fileName: Type.String({ minLength: 1, maxLength: 255 }), content: Type.String() }, { additionalProperties: false }),
]);

type OutputInput = Static<typeof outputInputSchema>;

export function createOutputTool(store: IssueOutputStore): ToolDefinition<any, any, any> {
  return defineTool({
    name: "output",
    label: "Write Issue Output",
    description: "Create, append, or list durable output files for the current production data-processing Issue. This tool cannot modify repositories.",
    promptSnippet: "Write durable SQL, CSV, JSON, JSONL, text, or Markdown result files",
    promptGuidelines: [
      "Use output for user-deliverable files only; repository snapshots remain read-only.",
      "Use append for chunked large results and report each generated file name in the final answer.",
    ],
    parameters: outputInputSchema,
    execute: async (_id, rawInput): Promise<AgentToolResult<unknown>> => {
      let input: OutputInput;
      try { input = Value.Parse(outputInputSchema, rawInput ?? {}); }
      catch { throw new Error("invalid_output_input"); }
      if (input.operation === "list") {
        const outputs = await store.list();
        return capabilityTextResult(capabilityResultText({ outputs }), { operation: "list", files: outputs.length });
      }
      const output = input.operation === "write"
        ? await store.write(input.fileName, input.content)
        : await store.append(input.fileName, input.content);
      return capabilityTextResult(capabilityResultText({ output }), { operation: input.operation, fileName: output.fileName, size: output.size });
    },
  });
}
