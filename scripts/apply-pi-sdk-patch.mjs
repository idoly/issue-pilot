import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageFile = new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url);
const { version } = JSON.parse(readFileSync(packageFile, "utf8"));
if (version !== "1.3.0") throw new Error("pi_sdk_patch_version_mismatch");
const patch = "patches/@earendil-works+pi-coding-agent+1.3.0.patch";
const check = args => {
  try { execFileSync("git", ["apply", ...args, patch], { cwd: root, stdio: "ignore" }); return true; }
  catch (error) { if (error.code === "ENOENT") throw new Error("git_required_for_pi_sdk_patch"); return false; }
};
if (!check(["--reverse", "--check"])) {
  if (!check(["--check"])) throw new Error("pi_sdk_patch_does_not_apply");
  execFileSync("git", ["apply", patch], { cwd: root, stdio: "inherit" });
}
console.log("Verified Pi SDK output callbacks (1.3.0).");
