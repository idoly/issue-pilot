import { createCodemodeExtension, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { generatedWorkFileSaver } from "../workspace/work-files.ts";

export function createIssueCodemodeExtension(root: string): ExtensionFactory {
  return createCodemodeExtension({ models: false, saveOutput: generatedWorkFileSaver(root, "codemode") });
}
