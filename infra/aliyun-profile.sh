#!/bin/sh
set -eu

profile_root=$1
cli=$2
shift 2

HOME=$profile_root
ALIBABA_CLOUD_ORIGINAL_PRODUCT_HELP=true
export HOME ALIBABA_CLOUD_ORIGINAL_PRODUCT_HELP
exec "$cli" "$@"
