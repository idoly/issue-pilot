#!/bin/sh
set -eu

profile_root=$1
cli=$2
shift 2

HOME=$profile_root
export HOME
exec "$cli" "$@"
