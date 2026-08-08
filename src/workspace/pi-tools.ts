import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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

export async function preparePiWorkspace(workspaceRoot: string): Promise<void> {
  const binRoot = path.join(workspaceRoot, ".issue-pilot", "bin");
  await mkdir(binRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(binRoot, "node-project"), NODE_PROJECT, { mode: 0o700 }),
    writeFile(path.join(binRoot, "maven-project"), MAVEN_PROJECT, { mode: 0o700 }),
  ]);
}
