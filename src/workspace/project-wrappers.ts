import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { replaceGeneratedDirectory } from "./generated-directory.ts";

const requestTimeoutSeconds = Math.ceil(issuePilotConfig.runtime.projectTools.executionMs / 1000) + 30;

const PROJECT_WRAPPER_HEADER = `#!/bin/sh
set -eu
runtime_bin=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
issue_root=$(dirname "$(dirname "$runtime_bin")")
state_root=$(dirname "$(dirname "$issue_root")")
issue_segment=$(basename "$issue_root")
issue_workspace=$(realpath -e "$state_root/workspaces/$issue_segment")
project=$(realpath -e "\${1:-.}")
case "$project" in "$issue_workspace"/*) ;; *) echo "project outside issue workspace" >&2; exit 2 ;; esac
workspace_relative=\${project#"$issue_workspace"/}
repository=\${workspace_relative%%/*}
case "$repository" in ""|*[!a-z0-9._-]*) echo "invalid project repository" >&2; exit 2 ;; esac
case "$workspace_relative" in */*) project_relative=\${workspace_relative#*/} ;; *) project_relative="" ;; esac
action=\${2:-test}
if [ "$#" -ge 2 ]; then shift 2; else shift 1; fi
socket="$state_root/control/project-tools.sock"
[ -S "$socket" ] || { echo "project tool broker unavailable" >&2; exit 1; }
encode() { printf '%s' "$1" | base64 | tr -d '\\n'; }
submit() {
  {
    printf '%s\\n' 'issue-pilot-project-tool-v1'
    printf '%s\\n' "$(encode "$tool")" "$(encode "$issue_segment")" "$(encode "$repository")" "$(encode "$project_relative")" "$(encode "$action")"
    for argument do printf '%s\\n' "$(encode "$argument")"; done
  } | curl --silent --show-error --fail-with-body --max-time ${requestTimeoutSeconds} --unix-socket "$socket" --header 'Content-Type: application/vnd.issue-pilot.project-tool' --data-binary @- http://localhost/v1/project-tools
}
`;

const NODE_PROJECT = `${PROJECT_WRAPPER_HEADER}tool=node
case "$action" in install|test|build|typecheck) ;; *) echo "unsupported node action" >&2; exit 2 ;; esac
submit "$@"
`;

const MAVEN_PROJECT = `${PROJECT_WRAPPER_HEADER}tool=maven
case "$action" in test|verify|package) ;; *) echo "unsupported maven action" >&2; exit 2 ;; esac
submit "$@"
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
    await replaceGeneratedDirectory(binRoot, temporaryRoot, previousRoot);
    return binRoot;
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
