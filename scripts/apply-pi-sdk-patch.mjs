import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const patches = [
  { name: "@earendil-works/pi-coding-agent", version: "1.4.0", file: "patches/@earendil-works+pi-coding-agent+1.4.0.patch" },
  { name: "node-forge", version: "1.4.0", file: "patches/node-forge+1.4.0.patch" },
];
for (const patch of patches) {
  const packageFile = new URL(`../node_modules/${patch.name}/package.json`, import.meta.url);
  if (JSON.parse(readFileSync(packageFile, "utf8")).version !== patch.version) throw new Error(`dependency_patch_version_mismatch:${patch.name}`);
  const check = args => {
    try { execFileSync("git", ["apply", ...args, patch.file], { cwd: root, stdio: "ignore" }); return true; }
    catch (error) { if (error.code === "ENOENT") throw new Error("git_required_for_dependency_patches"); return false; }
  };
  if (!check(["--reverse", "--check"])) {
    if (!check(["--check"])) throw new Error(`dependency_patch_does_not_apply:${patch.name}`);
    execFileSync("git", ["apply", patch.file], { cwd: root, stdio: "inherit" });
  }
  console.log(`Verified dependency patch: ${patch.name}@${patch.version}.`);
}
