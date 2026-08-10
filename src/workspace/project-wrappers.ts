import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { globalRuntimeRoot } from "./state.ts";

const NODE_PROJECT = `#!/bin/sh
set -eu
project=$(realpath -e "\${1:-.}")
case "$project" in "$ISSUE_WORKSPACE"|"$ISSUE_WORKSPACE"/*) ;; *) echo "project outside issue workspace" >&2; exit 2 ;; esac
action=\${2:-test}
case "$action" in
  install)
    shift 2
    package_manager=$(node -e 'process.stdout.write(require(process.argv[1]).packageManager || "npm")' "$project/package.json")
    case "$package_manager" in
      yarn@*) set -- corepack "$package_manager" install --frozen-lockfile "$@" ;;
      npm@*|npm) if [ -f "$project/package-lock.json" ]; then set -- npm ci "$@"; else set -- npm install "$@"; fi ;;
      *) echo "unsupported package manager: $package_manager" >&2; exit 2 ;;
    esac
    ;;
  test|build|typecheck) shift 2; set -- npm run "$action" -- "$@" ;;
  *) echo "unsupported node action" >&2; exit 2 ;;
esac
cd "$project"
exec "$@"
`;

const MAVEN_PROJECT = `#!/bin/sh
set -eu
project=$(realpath -e "\${1:-.}")
case "$project" in "$ISSUE_WORKSPACE"|"$ISSUE_WORKSPACE"/*) ;; *) echo "project outside issue workspace" >&2; exit 2 ;; esac
action=\${2:-test}
case "$action" in test|verify|package) shift 2 ;; *) echo "unsupported maven action" >&2; exit 2 ;; esac
cd "$project"
exec mvn --batch-mode --no-transfer-progress "$action" "$@"
`;

export async function assertManagedProjectWrappers(binRoot: string): Promise<void> {
  const expected = new Map([["node-project", NODE_PROJECT], ["maven-project", MAVEN_PROJECT]]);
  const entries = await readdir(binRoot, { withFileTypes: true });
  if (entries.length !== expected.size) throw new Error("workspace_has_untracked_files");
  for (const entry of entries) {
    const content = expected.get(entry.name);
    if (!entry.isFile() || content === undefined) throw new Error("workspace_has_untracked_files");
    const wrapperPath = path.join(binRoot, entry.name);
    if (await readFile(wrapperPath, "utf8") !== content || !(await stat(wrapperPath)).isFile()) throw new Error("workspace_has_untracked_files");
  }
}

export async function prepareProjectWrappers(runtimeRoot: string): Promise<string> {
  const binRoot = path.join(runtimeRoot, "bin");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await chmod(runtimeRoot, 0o700);
  await mkdir(binRoot, { recursive: true, mode: 0o700 });
  await chmod(binRoot, 0o700);
  await Promise.all([
    writeFile(path.join(binRoot, "node-project"), NODE_PROJECT, { mode: 0o700 }).then(() => chmod(path.join(binRoot, "node-project"), 0o700)),
    writeFile(path.join(binRoot, "maven-project"), MAVEN_PROJECT, { mode: 0o700 }).then(() => chmod(path.join(binRoot, "maven-project"), 0o700)),
  ]);
  return binRoot;
}

export async function retireGlobalProjectWrappers(stateRoot: string): Promise<boolean> {
  const runtimeRoot = globalRuntimeRoot(stateRoot);
  let entries;
  try {
    entries = await readdir(runtimeRoot, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  if (entries.length !== 1 || entries[0]?.name !== "bin" || !entries[0].isDirectory()) throw new Error("global_runtime_has_untracked_files");
  await assertManagedProjectWrappers(path.join(runtimeRoot, "bin"));
  await rm(runtimeRoot, { recursive: true });
  return true;
}
