import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const PROJECT_WRAPPER_HEADER = `#!/bin/sh
set -eu
runtime_bin=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
issue_root=$(dirname "$(dirname "$runtime_bin")")
state_root=$(dirname "$(dirname "$issue_root")")
issue_workspace=$(realpath -e "$state_root/workspaces/$(basename "$issue_root")")
project=$(realpath -e "\${1:-.}")
case "$project" in "$issue_workspace"|"$issue_workspace"/*) ;; *) echo "project outside issue workspace" >&2; exit 2 ;; esac
action=\${2:-test}
`;

const NODE_PROJECT = `${PROJECT_WRAPPER_HEADER}case "$action" in
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

const MAVEN_PROJECT = `${PROJECT_WRAPPER_HEADER}case "$action" in test|verify|package) shift 2 ;; *) echo "unsupported maven action" >&2; exit 2 ;; esac
cd "$project"
exec mvn --batch-mode --no-transfer-progress "$action" "$@"
`;

export async function prepareProjectWrappers(runtimeRoot: string): Promise<string> {
  const binRoot = path.join(runtimeRoot, "bin");
  const operationId = randomUUID();
  const temporaryRoot = path.join(runtimeRoot, `.bin-${operationId}`);
  const previousRoot = path.join(runtimeRoot, `.bin-previous-${operationId}`);
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await chmod(runtimeRoot, 0o700);
  try {
    await mkdir(temporaryRoot, { mode: 0o700 });
    await Promise.all([
      writeFile(path.join(temporaryRoot, "node-project"), NODE_PROJECT, { mode: 0o700 }),
      writeFile(path.join(temporaryRoot, "maven-project"), MAVEN_PROJECT, { mode: 0o700 }),
    ]);
    let previous = false;
    try {
      await rename(binRoot, previousRoot);
      previous = true;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    try {
      await rename(temporaryRoot, binRoot);
    } catch (error) {
      if (previous) await rename(previousRoot, binRoot);
      throw error;
    }
    if (previous) await rm(previousRoot, { recursive: true });
    return binRoot;
  } catch (error) {
    await Promise.all([
      rm(temporaryRoot, { recursive: true, force: true }),
      rm(previousRoot, { recursive: true, force: true }),
    ]);
    throw error;
  }
}
