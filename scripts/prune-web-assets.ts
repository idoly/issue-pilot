// Keeps the Web assets of the current and previous release generations and removes older hashed bundles.
// Usage: node --experimental-strip-types scripts/prune-web-assets.ts [web-root] [--apply | --check-current]
// Without --apply this only lists what would be removed.
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { applicationConfig } from "../src/config.ts";
import { isHashedWebAsset } from "../src/http/web-assets.ts";

const generations = [
  { manifest: ".vite/manifest.json", html: "index.html" },
  { manifest: ".vite/manifest.previous.json", html: "index.previous.html" },
];

interface ManifestChunk {
  file: string;
  css?: string[];
  assets?: string[];
}

async function manifestFiles(root: string, name: string): Promise<Set<string>> {
  let manifest: Record<string, ManifestChunk>;
  try {
    manifest = JSON.parse(await readFile(path.join(root, name), "utf8")) as Record<string, ManifestChunk>;
  } catch (error) {
    throw new Error(`web_manifest_unreadable:${name}`, { cause: error });
  }
  const files = new Set<string>();
  for (const chunk of Object.values(manifest)) for (const file of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]) files.add(file);
  for (const file of files) {
    if (!/^assets\/[^/]+$/.test(file)) throw new Error(`web_manifest_unexpected_path:${name}:${file}`);
    const info = await lstat(path.join(root, file)).catch(() => undefined);
    // A missing referenced file means the release copy is incomplete; pruning would hide it.
    if (!info?.isFile()) throw new Error(`web_manifest_file_missing:${name}:${file}`);
  }
  return files;
}

async function htmlReferences(root: string, name: string): Promise<string[]> {
  const html = await readFile(path.join(root, name), "utf8");
  return [...html.matchAll(/(?:src|href)="\/(assets\/[^"?#]+)"/g)].map((match) => match[1]!);
}

async function validateGeneration(root: string, generation: (typeof generations)[number]): Promise<Set<string>> {
  const files = await manifestFiles(root, generation.manifest);
  for (const reference of await htmlReferences(root, generation.html)) {
    if (isHashedWebAsset(reference) && !files.has(reference)) throw new Error(`web_manifest_html_mismatch:${generation.html}:${reference}`);
    if (!files.has(reference)) {
      const info = await lstat(path.join(root, reference)).catch(() => undefined);
      if (!info?.isFile()) throw new Error(`web_html_file_missing:${generation.html}:${reference}`);
    }
  }
  return files;
}

export async function planWebAssetPrune(root: string): Promise<{ keep: Set<string>; remove: string[] }> {
  const keep = new Set<string>();
  for (const generation of generations) {
    const files = await validateGeneration(root, generation);
    for (const file of files) keep.add(file);
  }
  const remove: string[] = [];
  for (const entry of await readdir(path.join(root, "assets"), { withFileTypes: true })) {
    // Directories (editor icons) and stable names (public files, licenses) are replaced in place, never pruned.
    if (!entry.isFile()) continue;
    const file = `assets/${entry.name}`;
    if (!isHashedWebAsset(file) || keep.has(file.replace(/\.(?:br|gz)$/, ""))) continue;
    remove.push(file);
  }
  return { keep, remove: remove.sort() };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { apply: { type: "boolean" }, "check-current": { type: "boolean" } } });
  if (positionals.length > 1 || (values.apply && values["check-current"])) throw new Error("usage: prune-web-assets.ts [web-root] [--apply | --check-current]");
  const root = path.resolve(positionals[0] ?? applicationConfig.webRoot);
  if (values["check-current"]) {
    await validateGeneration(root, generations[0]!);
    return;
  }
  const { keep, remove } = await planWebAssetPrune(root);
  console.log(`${values.apply ? "Removing" : "Would remove"} ${remove.length} files; keeping ${keep.size} manifest files of two generations in ${root}`);
  for (const file of remove) {
    console.log(file);
    if (values.apply) await rm(path.join(root, file));
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
