#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$root"

command -v node >/dev/null 2>&1 || { printf 'Node.js is required.\n' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { printf 'npm is required.\n' >&2; exit 1; }

npm ci
npm --prefix apps/web ci --legacy-peer-deps
npm run typecheck
npm test
npm --prefix apps/web run typecheck
npm --prefix apps/web test
npm --prefix apps/web run build

printf 'Clone verification passed.\n'
printf 'For local infrastructure: copy infra/.env.example to infra/.env, set unique secrets, chmod 600 infra/.env, then run ./infra/podman-stack.sh start.\n'
printf 'For state recovery, use docs/DEPLOYMENT_AND_RECOVERY.md and an authorized encrypted snapshot.\n'
