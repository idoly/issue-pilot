import { readFile } from "node:fs/promises";

/**
 * Runtime dependency patches applied by scripts/apply-pi-sdk-patch.mjs at postinstall. An install that skipped
 * scripts (for example `npm ci --ignore-scripts`) would otherwise run the unpatched SDK silently.
 * Monaco is build-only and is not loaded by the server.
 */
const RUNTIME_PATCHES = ["@earendil-works+pi-coding-agent+1.5.2.patch", "zod+4.6.7.patch"] as const;
const checkoutRoot = new URL("../../", import.meta.url);

let verified: Promise<void> | undefined;

/** Cheap content check: every patched file must contain each nontrivial line the patch adds. */
export function assertRuntimeDependencyPatches(): Promise<void> {
  return (verified ??= verifyDependencyPatches(checkoutRoot, RUNTIME_PATCHES).catch((error: unknown) => {
    verified = undefined;
    throw error;
  }));
}

/** Exported for tests; the root is a checkout directory URL containing patches/ and the patched files. */
export async function verifyDependencyPatches(root: URL, patches: readonly string[]): Promise<void> {
  for (const patch of patches) {
    const added = new Map<string, string[]>();
    let target: string[] | undefined;
    for (const line of (await readFile(new URL(`patches/${patch}`, root), "utf8")).split("\n")) {
      if (line.startsWith("+++ ")) {
        const file = line.slice(4).replace(/^b\//, "");
        target = [];
        added.set(file, target);
      } else if (line.startsWith("diff --git ")) target = undefined;
      else if (target && line.startsWith("+") && line.slice(1).trim().length > 3) target.push(line.slice(1));
    }
    if (!added.size) throw new Error(`dependency_patch_invalid:${patch}`);
    for (const [file, lines] of added) {
      const content = await readFile(new URL(file, root), "utf8");
      if (lines.some((line) => !content.includes(line))) throw new Error(`dependency_patch_not_applied:${file}: run npm ci without --ignore-scripts or node scripts/apply-pi-sdk-patch.mjs`);
    }
  }
}
