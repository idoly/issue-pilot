import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { issueRoot, legacyIssueRoot, sharedCheckoutsRoot, workspacesRoot } from "./state.ts";
import { legacyOutputLinks, legacyOutputLinksFile } from "../outputs/store.ts";
import { workFileName } from "./work-file-store.ts";

export interface FlatLayoutIssue { id: string; key: string; repositoryNames: string[] }
export interface FlatLayoutAttachment { id: string; issueId: string; objectKey: string; size: number; sha256: string; workingFileName: string | null }
export interface FlatLayoutSession { issueId: string; sessionFile: string; workspacePath: string }
interface Move { issueKey: string; source: string; target: string; sha256: string; mode: number; duplicate: boolean }
interface Manifest { path: string; previous?: string; content: string }
export interface FlatLayoutPlan {
  moves: Move[]; manifests: Manifest[]; generated: string[]; oldDirectories: string[];
  attachments: Array<{ id: string; objectKey: string; workingFileName: string }>;
  sessions: Array<{ issueId: string; sessionFile: string; workspacePath: string }>;
  roots: string[];
}
async function metadata(file: string) { return lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; }); }
async function hash(file: string): Promise<string> { const value = createHash("sha256"); for await (const data of createReadStream(file)) value.update(data); return value.digest("hex"); }
async function entries(root: string): Promise<string[]> { if (!await metadata(root)) return []; if (!(await lstat(root)).isDirectory()) throw new Error("flat_layout_invalid_directory"); return readdir(root); }
function within(root: string, value: string) { const relative = path.relative(root, value); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
async function validateGeneratedRuntime(stateRoot: string, selected: string, repositoryNames: string[], phase: "root" | "bin" | "related" | "issue" | "repositories" = "root"): Promise<string[]> {
  const info = await lstat(selected);
  if (!info.isDirectory()) throw new Error("flat_layout_runtime_requires_inspection");
  const files: string[] = [];
  for (const name of await readdir(selected)) {
    const child = path.join(selected, name), metadata = await lstat(child);
    if (metadata.isSymbolicLink()) {
      const repository = phase === "repositories" || phase === "root" && repositoryNames.includes(name);
      const conversation = phase === "issue" && name === "conversation.jsonl";
      const target = path.resolve(selected, await readlink(child));
      if (!(repository && (within(sharedCheckoutsRoot(stateRoot), target) || within(workspacesRoot(stateRoot), target)) || conversation && (within(path.join(stateRoot, "issues"), target) || within(workspacesRoot(stateRoot), target)))) throw new Error("flat_layout_runtime_link_requires_inspection");
    } else if (metadata.isDirectory()) {
      const next = phase === "root" && name === "bin" ? "bin" : phase === "root" && name === "related-issues" ? "related" : phase === "related" && /^issue-[0-9]{8}-[0-9]{3,}$/.test(name) ? "issue" : phase === "issue" && name === "repositories" ? "repositories" : undefined;
      if (!next) throw new Error("flat_layout_runtime_directory_requires_inspection");
      files.push(...await validateGeneratedRuntime(stateRoot, child, repositoryNames, next));
    } else if (metadata.isFile()) {
      const content = await readFile(child, "utf8");
      const wrapper = phase === "bin" && ["node-project", "maven-project"].includes(name) && content.startsWith("#!/bin/sh\nset -eu\nruntime_bin=");
      let issue = false;
      if (phase === "issue" && name === "issue.json") {
        let data: unknown;
        try { data = JSON.parse(content); } catch { throw new Error("flat_layout_runtime_file_requires_inspection"); }
        issue = data !== null && typeof data === "object" && "key" in data && typeof data.key === "string" && data.key.toLowerCase() === path.basename(selected);
      }
      if (!wrapper && !issue) throw new Error("flat_layout_runtime_file_requires_inspection");
      files.push(child);
    } else throw new Error("flat_layout_runtime_requires_inspection");
  }
  return files;
}
/** An explicit offline plan, never an automatic layout adoption. */
export async function planFlatIssueLayout(stateRoot: string, issues: FlatLayoutIssue[], attachments: FlatLayoutAttachment[], sessions: FlatLayoutSession[]): Promise<FlatLayoutPlan> {
  if (await realpath(stateRoot) !== path.resolve(stateRoot)) throw new Error("flat_layout_invalid_directory");
  const plan: FlatLayoutPlan = { moves: [], manifests: [], generated: [], oldDirectories: [], attachments: [], sessions: [], roots: [] };
  const targets = new Map<string, string>();
  const add = async (issueKey: string, source: string, target: string, allowIdentical = false) => {
    const info = await lstat(source);
    if (!info.isFile()) throw new Error("flat_layout_source_requires_inspection");
    const digest = await hash(source), prior = targets.get(target), present = await metadata(target);
    if (prior || present) {
      if (!allowIdentical || prior && prior !== digest || present && (!present.isFile() || await hash(target) !== digest)) throw new Error(`flat_layout_file_collision:${issueKey}/${path.basename(target)}`);
    }
    targets.set(target, digest);
    plan.moves.push({ issueKey, source, target, sha256: digest, mode: info.mode & 0o7777, duplicate: Boolean(prior || present) });
  };
  for (const issue of issues) {
    const root = issueRoot(stateRoot, issue.key), old = legacyIssueRoot(stateRoot, issue.key);
    const rootInfo = await metadata(root);
    if (rootInfo && (!rootInfo.isDirectory() || await realpath(root) !== root)) throw new Error("flat_layout_issue_root_requires_inspection");
    if (await metadata(old) && await realpath(old) !== old) throw new Error("flat_layout_invalid_directory");
    plan.roots.push(root);
    const names = await entries(old), managed = new Set(["agent", "attachments", "outputs", "runtime", "work"]);
    if (names.length) {
      for (const name of await entries(root)) {
        if (name === ".issue-runtime.json" || /^\.related-issue-/.test(name)) throw new Error(`flat_layout_runtime_collision:${issue.key}/${name}`);
      }
    }
    for (const name of names.filter(name => !managed.has(name) && !/^\.runtime-(?:previous-)?[0-9a-f-]{36}$/.test(name))) {
      const source = path.join(old, name);
      if (!(await lstat(source)).isFile()) throw new Error(`flat_layout_unknown_issue_state:${issue.key}`);
      workFileName(name);
      await add(issue.key, source, path.join(root, name), true);
    }
    const sessionsForIssue = sessions.filter(row => row.issueId === issue.id);
    const sessionNames = await entries(path.join(old, "agent"));
    for (const name of sessionNames) {
      workFileName(name);
      const source = path.join(old, "agent", name);
      const info = await lstat(source);
      if (!info.isFile() || (info.mode & 0o7777) !== 0o600) throw new Error("flat_layout_session_requires_inspection");
      if (/^[0-9a-f-]{36}\.runtime\.json$/i.test(name)) {
        const data = JSON.parse(await readFile(source, "utf8"));
        if (Object.keys(data).some(key => !["issueId", "capabilities", "brokerUrl", "brokerToken"].includes(key)) || typeof data.issueId !== "string" || !Array.isArray(data.capabilities) || typeof data.brokerUrl !== "string" || typeof data.brokerToken !== "string") throw new Error("flat_layout_session_requires_inspection");
        await add(issue.key, source, path.join(root, `.runtime-${name}`));
        continue;
      }
      if (!name.endsWith(".jsonl")) throw new Error("flat_layout_session_requires_inspection");
      const header = JSON.parse((await readFile(source, "utf8")).split("\n")[0]!);
      if (header.type !== "session" || typeof header.id !== "string") throw new Error("flat_layout_session_requires_inspection");
      const target = path.join(root, `.session-${name}`);
      if (Buffer.byteLength(path.basename(target)) > 255) throw new Error("flat_layout_session_name_too_long");
      await add(issue.key, source, target);
      for (const binding of sessionsForIssue) if (path.resolve(binding.sessionFile) === source) plan.sessions.push({ issueId: binding.issueId, sessionFile: target, workspacePath: root });
    }
    for (const binding of sessionsForIssue) {
      if (path.dirname(path.resolve(binding.sessionFile)) === root) {
        const file = path.resolve(binding.sessionFile), info = await lstat(file);
        if (!path.basename(file).startsWith(".session-") || !file.endsWith(".jsonl") || !info.isFile() || (info.mode & 0o7777) !== 0o600) throw new Error("flat_layout_session_binding_requires_inspection");
        const header = JSON.parse((await readFile(file, "utf8")).split("\n")[0]!);
        if (header.type !== "session" || typeof header.id !== "string" || path.resolve(binding.workspacePath) !== root) throw new Error("flat_layout_session_binding_requires_inspection");
        continue;
      }
      if (!plan.sessions.some(row => row.issueId === binding.issueId)) throw new Error("flat_layout_session_binding_requires_inspection");
    }
    const files = attachments.filter(row => row.issueId === issue.id), tracked = new Set<string>();
    for (const file of files) {
      const source = path.resolve(file.objectKey);
      if (!/^[a-z0-9_-]+$/i.test(file.id)) throw new Error("flat_layout_attachment_path_requires_inspection");
      if (path.dirname(source) !== root && path.dirname(source) !== path.join(old, "attachments")) throw new Error("flat_layout_attachment_path_requires_inspection");
      const info = await lstat(source);
      if (!info.isFile() || (info.mode & 0o7777) !== 0o400 || info.size !== file.size || await hash(source) !== file.sha256) throw new Error("flat_layout_attachment_integrity_failed");
      if (path.dirname(source) === root) {
        if (!file.workingFileName || path.basename(source) !== `.attachment-${file.id}${path.extname(source)}`) throw new Error("flat_layout_attachment_path_requires_inspection");
        workFileName(file.workingFileName);
        continue;
      }
      tracked.add(path.basename(source));
      const extension = path.extname(source), suffix = Buffer.byteLength(extension) <= 20 ? extension : "";
      const target = path.join(root, `.attachment-${file.id}${suffix}`);
      const workingFileName = file.workingFileName ?? path.basename(source); workFileName(workingFileName);
      await add(issue.key, source, target);
      plan.attachments.push({ id: file.id, objectKey: target, workingFileName });
    }
    if ((await entries(path.join(old, "attachments"))).some(name => !tracked.has(name))) throw new Error(`flat_layout_untracked_attachment:${issue.key}`);
    const oldOutputs = path.join(old, "outputs"), outputs = await entries(oldOutputs), links = Object.assign(Object.create(null) as Record<string, string>, await legacyOutputLinks(stateRoot, issue.key));
    for (const name of outputs) {
      workFileName(name);
      const source = path.join(oldOutputs, name);
      if (!(await lstat(source)).isFile()) throw new Error("flat_layout_source_requires_inspection");
      const digest = await hash(source), normal = path.join(root, name), present = await metadata(normal);
      let chosen = name;
      if (present && (!present.isFile() || await hash(normal) !== digest) || targets.has(normal) && targets.get(normal) !== digest) {
        const extension = path.extname(name), suffix = `.delivery-${digest.slice(0, 12)}${extension}`;
        const base = name.slice(0, name.length - extension.length);
        let stem = ""; for (const character of base) { if (Buffer.byteLength(stem + character + suffix) > 255) break; stem += character; }
        chosen = workFileName(stem + suffix);
      }
      if (Object.hasOwn(links, name) && links[name] !== chosen) throw new Error("flat_layout_conflicting_output_alias");
      links[name] = chosen;
      await add(issue.key, source, path.join(root, chosen), true);
    }
    if (outputs.length) {
      const file = path.join(root, legacyOutputLinksFile), info = await metadata(file);
      if (info && (!info.isFile() || info.mode & 0o077)) throw new Error("insecure_legacy_output_links");
      plan.manifests.push({ path: file, ...(info ? { previous: await readFile(file, "utf8") } : {}), content: JSON.stringify({ version: 1, files: links }, null, 2) + "\n" });
    }
    for (const name of await entries(path.join(old, "work"))) await add(issue.key, path.join(old, "work", name), path.join(root, name));
    for (const name of names.filter(name => name === "runtime" || name.startsWith(".runtime-"))) {
      const selected = path.join(old, name);
      for (const source of await validateGeneratedRuntime(stateRoot, selected, issue.repositoryNames)) {
        const identity = createHash("sha256").update(path.relative(old, source)).digest("hex").slice(0, 16);
        await add(issue.key, source, path.join(root, `.runtime-legacy-${identity}-${path.basename(source)}`), true);
      }
      plan.generated.push(selected);
    }
    for (const name of ["agent", "attachments", "outputs", "work"]) if (await metadata(path.join(old, name))) plan.oldDirectories.push(path.join(old, name));
    if (await metadata(old)) plan.oldDirectories.push(old);
  }
  return plan;
}
export async function applyFlatIssueLayout(plan: FlatLayoutPlan, commit: (plan: FlatLayoutPlan) => Promise<void>, quarantineRoot: string): Promise<void> {
  const moved: Move[] = [], manifests: Manifest[] = [], generated: Array<{ source: string; target: string }> = [], created: string[] = [];
  let committed = false;
  try {
    for (const move of plan.moves) {
      const info = await lstat(move.source);
      if (!info.isFile() || (info.mode & 0o7777) !== move.mode || await hash(move.source) !== move.sha256) throw new Error("flat_layout_source_changed");
      const target = await metadata(move.target);
      if (target && (!move.duplicate || !target.isFile() || await hash(move.target) !== move.sha256)) throw new Error("flat_layout_target_changed");
    }
    for (const root of plan.roots) if (!await metadata(root)) { await mkdir(root, { recursive: true, mode: 0o700 }); created.push(root); }
    for (const move of plan.moves) if (!move.duplicate) { await rename(move.source, move.target); moved.push(move); }
    for (const item of plan.manifests) {
      const temporary = `${item.path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, item.content, { mode: 0o600, flag: "wx" }); await rename(temporary, item.path); manifests.push(item); }
      finally { await rm(temporary, { force: true }); }
    }
    await mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
    for (const source of plan.generated) { const target = path.join(quarantineRoot, String(generated.length)); await rename(source, target); generated.push({ source, target }); }
    await commit(plan); committed = true;
    for (const move of plan.moves.filter(move => move.duplicate)) await rm(move.source);
    for (const directory of plan.oldDirectories) await rmdir(directory);
    // These directories were explicitly inspected as generated runtime state before mutation.
    for (const entry of generated) await rm(entry.target, { recursive: true });
    await rmdir(quarantineRoot);
  } catch (error) {
    if (committed) throw new Error("flat_layout_committed_finalize_failed", { cause: error });
    const failures: unknown[] = [];
    for (const entry of generated.reverse()) try { await rename(entry.target, entry.source); } catch (failure) { failures.push(failure); }
    for (const item of manifests.reverse()) try { if (item.previous === undefined) await rm(item.path); else await writeFile(item.path, item.previous, { mode: 0o600 }); } catch (failure) { failures.push(failure); }
    for (const move of moved.reverse()) try { await rename(move.target, move.source); } catch (failure) { failures.push(failure); }
    for (const root of created.reverse()) try { await rmdir(root); } catch (failure) { failures.push(failure); }
    if (failures.length) throw new AggregateError([error, ...failures], "flat_layout_rollback_failed");
    throw error;
  }
}
