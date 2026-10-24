import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { Compile } from "typebox/compile";
import { createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { KeyedSerialQueue } from "../serial.ts";
import { executeLocalCommand } from "../process.ts";
import { assertIssueLaunchEnvironment, prepareIssueCommand, type IssueFilesystemPolicy } from "./issue-sandbox.ts";

export const issueLocalCommands = new KeyedSerialQueue();
/** Shared writable inodes would bypass the mount boundary. Inspect before starting a session. */
export async function assertIssueHardlinks(root: string): Promise<void> {
  const linked = new Map<string, { seen: number; links: number }>();
  const scan = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const selected = path.join(directory, entry.name), info = await lstat(selected);
      if (info.isDirectory()) await scan(selected);
      else if (info.isFile() && info.nlink > 1) { const key = `${info.dev}:${info.ino}`, previous = linked.get(key); linked.set(key, { seen: (previous?.seen ?? 0) + 1, links: info.nlink }); }
    }
  };
  await scan(root);
  if ([...linked.values()].some(entry => entry.seen < entry.links)) throw new Error("issue_external_hardlink_requires_inspection");
}
function environment(extra: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "LANG", "LANGUAGE", "LC_ALL", "TZ", "JAVA_HOME", "MAVEN_HOME", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"]) if (process.env[name] !== undefined) result[name] = process.env[name]!;
  assertIssueLaunchEnvironment(extra);
  const gitConfigCount = Number(extra.GIT_CONFIG_COUNT ?? "0");
  if (!Number.isInteger(gitConfigCount) || gitConfigCount < 0 || gitConfigCount > 128) throw new Error("invalid_issue_git_environment");
  const gitConfig = Array.from({ length: gitConfigCount }, (_, index) => [extra[`GIT_CONFIG_KEY_${index}`], extra[`GIT_CONFIG_VALUE_${index}`]]);
  if (gitConfig.some(([key, value]) => !key || value === undefined)) throw new Error("invalid_issue_git_environment");
  return {
    ...result, NODE_PATH: path.resolve(import.meta.dirname, "../../node_modules"), ...extra,
    ...(extra.GIT_SSH_COMMAND ? { ISSUE_PILOT_PERSONAL_GIT_SSH: extra.GIT_SSH_COMMAND } : {}),
    ...(gitConfig.length ? { ISSUE_PILOT_GIT_CONFIG: JSON.stringify(gitConfig) } : {}),
  };
}
export function issueNativeTools(policy: IssueFilesystemPolicy, getEnvironment: () => Record<string, string> = () => ({})): ToolDefinition<any, any, any>[] {
  const root = policy.writeRoot;
  return [createReadToolDefinition(root), createBashToolDefinition(root), createEditToolDefinition(root), createWriteToolDefinition(root), createGrepToolDefinition(root), createFindToolDefinition(root), createLsToolDefinition(root)].map(tool => {
    const validate = Compile(tool.parameters);
    const { renderCall: _renderCall, renderResult: _renderResult, ...metadata } = tool;
    return { ...metadata, execute: (_id: string, input: unknown, signal: AbortSignal | undefined, update: ((value: any) => void) | undefined) => issueLocalCommands.run(root, async () => {
      if (!validate.Check(input)) throw new Error(`invalid_issue_${tool.name}_input`);
      signal?.throwIfAborted();
      const prepared = await prepareIssueCommand(policy, [process.execPath, "--experimental-strip-types", path.join(import.meta.dirname, "native-tool-executor.ts"), tool.name, root]);
      let buffer = "", result: any, failure: string | undefined;
      let failed = false, primary: unknown;
      try {
        const [executable, ...args] = prepared.argv;
        const execution = await executeLocalCommand(executable!, args, {
          cwd: root, environment: environment(getEnvironment()), input: Buffer.from(JSON.stringify(input)), maxOutputBytes: null,
          ...(signal ? { signal } : {}), strictStdoutUtf8: true,
          onStdout: text => {
            buffer += text;
            let end: number;
            while ((end = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
              const packet: unknown = JSON.parse(line);
              if (!packet || typeof packet !== "object" || !("type" in packet) || !("data" in packet)) throw new Error("invalid_issue_tool_response");
              if (packet.type === "error" && typeof packet.data === "string") { failure = packet.data; continue; }
              if (!packet.data || typeof packet.data !== "object" || !("content" in packet.data) || !Array.isArray(packet.data.content)) throw new Error("invalid_issue_tool_response");
              if (packet.type === "update") update?.(packet.data);
              else if (packet.type === "result" && result === undefined) result = packet.data;
              else throw new Error("invalid_issue_tool_response");
            }
          },
        });
        signal?.throwIfAborted();
        if (failure) throw new Error(failure);
        if (execution.code !== 0 || result === undefined || buffer.length) throw new Error("issue_native_tool_failed");
        return result;
      } catch (error) { failed = true; primary = error; throw error; }
      finally { try { await prepared.cleanup(); } catch (error) { if (failed) throw new AggregateError([primary, error], "issue_tool_cleanup_failed"); throw error; } }
    }) };
  });
}
