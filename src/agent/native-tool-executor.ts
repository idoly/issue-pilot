import { access, lstat, mkdir, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { isManagedIssueFile } from "../workspace/working-files.ts";

const [name, root] = process.argv.slice(2);
const send = (type: string, data: unknown) => process.stdout.write(JSON.stringify({ type, data }) + "\n");
try {
  if (!root || !path.isAbsolute(root)) throw new Error("invalid_issue_tool_root");
  const own = async (file: string) => {
    const relative = path.relative(root, file);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("issue_write_outside_directory");
    if (isManagedIssueFile(relative) || relative.split(path.sep).some(part => part.toLowerCase() === ".git")) throw new Error("managed_issue_file_private");
    const inside = (value: string) => { const relative = path.relative(root, value); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
    let ancestor = file;
    while (true) {
      const metadata = await lstat(ancestor).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (metadata?.isSymbolicLink() && !inside(path.resolve(path.dirname(ancestor), await readlink(ancestor)))) throw new Error("issue_write_outside_directory");
      try {
        const actual = await realpath(ancestor);
        if (!inside(actual)) throw new Error("issue_write_outside_directory");
        if (isManagedIssueFile(path.relative(root, actual))) throw new Error("managed_issue_file_private");
        break;
      } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; ancestor = path.dirname(ancestor); }
    }
  };
  const save = async (file: string, content: string) => {
    await own(file);
    const temporary = path.join(path.dirname(file), `.edit-${randomUUID()}.tmp`);
    try { await writeFile(temporary, content, { flag: "wx", mode: 0o600 }); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
  };
  const factories = {
    read: () => createReadToolDefinition(root, { autoResizeImages: process.env.ISSUE_PILOT_IMAGE_AUTO_RESIZE !== "false" }),
    bash: () => createBashToolDefinition(root, { ...(process.env.ISSUE_PILOT_SHELL_PATH ? { shellPath: process.env.ISSUE_PILOT_SHELL_PATH } : {}), ...(process.env.ISSUE_PILOT_SHELL_PREFIX ? { commandPrefix: process.env.ISSUE_PILOT_SHELL_PREFIX } : {}) }),
    grep: () => createGrepToolDefinition(root),
    find: () => createFindToolDefinition(root),
    ls: () => createLsToolDefinition(root),
    write: () => createWriteToolDefinition(root, { operations: { mkdir: async directory => { await own(directory); await mkdir(directory, { recursive: true, mode: 0o700 }); }, writeFile: save } }),
    edit: () => createEditToolDefinition(root, { operations: { access: async file => { await own(file); await access(file); }, readFile: async file => { await own(file); return readFile(file); }, writeFile: save } }),
  };
  if (!name || !Object.hasOwn(factories, name)) throw new Error("invalid_issue_tool_name");
  const tool = factories[name as keyof typeof factories]();
  const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Compile(tool.parameters).Check(input)) throw new Error("invalid_issue_tool_input");
  const signal = new AbortController();
  process.once("SIGTERM", () => signal.abort(new Error("issue_tool_cancelled")));
  const context = { cwd: root, sessionManager: { getSessionId: () => process.env.PI_SESSION_ID ?? "", getSessionFile: () => process.env.PI_SESSION_FILE }, model: { provider: process.env.PI_PROVIDER ?? "", id: process.env.PI_MODEL ?? "", input: JSON.parse(process.env.PI_MODEL_INPUT ?? '["text","image"]'), inputLimits: { images: { resize: JSON.parse(process.env.PI_MODEL_IMAGE_RESIZE ?? "null") ?? undefined } } }, thinkingLevel: process.env.PI_REASONING_LEVEL };
  const result = await tool.execute("issue-local", input as never, signal.signal, value => send("update", value), context as never);
  send("result", result);
} catch (error) { send("error", error instanceof Error ? error.message : "issue_native_tool_failed"); process.exitCode = 1; }
