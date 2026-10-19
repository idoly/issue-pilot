import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { capabilityResultText, capabilityTextResult, structuredJsonResult } from "../capabilities/contracts.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { IssueOutputStore } from "../outputs/store.ts";

const schema = Type.Union([
  Type.Object({ operation: Type.Literal("list") }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("publish"), sourcePath: Type.String({ minLength: 1 }), fileName: Type.String({ minLength: 1, maxLength: issuePilotConfig.limits.filesystemNameBytes, description: "Delivery basename; the UTF-8 byte limit also applies." }) }, { additionalProperties: false }),
]);
const validateInput = Compile(schema);

export function createOutputTool(store: IssueOutputStore, workDirectory: string) {
  return defineTool({
    name: "output", label: "Issue outputs", parameters: schema, outputSchema: Type.Unknown(),
    description: "List published outputs or publish a regular file from this Issue's working directory. Generate any file format with the native coding tools, then publish it by sourcePath and delivery fileName. Publication is atomic and returns metadata only.",
    promptGuidelines: ["Create files in the working directory and use publish for delivery. Name every published file in the final answer."],
    execute: async (_id, input, signal) => {
      if (!validateInput.Check(input)) throw new Error("invalid_output_input");
      signal?.throwIfAborted();
      if (input.operation === "list") return structuredJsonResult(capabilityTextResult(capabilityResultText({ directory: store.directory, outputs: await store.list() }), { operation: "list" }));
      const root = await realpath(workDirectory);
      const source = await realpath(path.resolve(root, input.sourcePath));
      const relative = path.relative(root, source);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("output_source_outside_work_directory");
      const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await handle.stat()).isFile()) throw new Error("output_source_not_file");
        const output = await store.generate(input.fileName, async append => {
          const buffer = Buffer.alloc(64 * 1024);
          while (true) {
            signal?.throwIfAborted();
            const { bytesRead } = await handle.read(buffer);
            if (!bytesRead) break;
            await append(buffer.subarray(0, bytesRead));
          }
          await handle.close();
          signal?.throwIfAborted();
        });
        return structuredJsonResult(capabilityTextResult(capabilityResultText({ output: { fileName: output.fileName, size: output.size, updatedAt: output.updatedAt } }), { operation: "publish", fileName: output.fileName }));
      } finally { await handle.close(); }
    },
  });
}
