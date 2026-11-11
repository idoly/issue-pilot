import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const patches = [
  { name: "@earendil-works/pi-coding-agent", version: "1.5.2", file: "patches/@earendil-works+pi-coding-agent+1.5.2.patch" },
  { name: "zod", version: "4.6.7", file: "patches/zod+4.6.7.patch" },
  { name: "monaco-editor", version: "0.57.0", file: "patches/monaco-editor+0.57.0.patch", buildOnly: true },
];
for (const patch of patches) {
  const packageFile = new URL(`../node_modules/${patch.name}/package.json`, import.meta.url);
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(packageFile, "utf8"));
  } catch (error) {
    // Production-only installations serve the prebuilt Web bundle without Monaco's build dependency.
    if (patch.buildOnly && error.code === "ENOENT") {
      console.log(`Skipped build-only dependency patch: ${patch.name} (not installed).`);
      continue;
    }
    throw error;
  }
  if (metadata.version !== patch.version) throw new Error(`dependency_patch_version_mismatch:${patch.name}`);
  const check = (args) => {
    try {
      execFileSync("git", ["apply", ...args, patch.file], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
      return true;
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("git_required_for_dependency_patches");
      // Exit code 1 means the patch context does not match; anything else (permissions, broken worktree) must surface.
      if (error.status === 1) return false;
      throw new Error(`dependency_patch_check_failed:${patch.name}:${String(error.stderr ?? error.message).trim()}`, { cause: error });
    }
  };
  if (!check(["--reverse", "--check"])) {
    if (!check(["--check"])) throw new Error(`dependency_patch_does_not_apply:${patch.name}`);
    execFileSync("git", ["apply", patch.file], { cwd: root, stdio: "inherit" });
  }
  console.log(`Verified dependency patch: ${patch.name}@${patch.version}.`);
}
