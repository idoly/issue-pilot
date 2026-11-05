#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
fixture_root=$(mktemp -d "${TMPDIR:-/tmp}/issue-pilot-ssh-harness-XXXXXX")
fixture_image=localhost/issue-pilot-ssh-fixture:local
trap 'rm -rf "$fixture_root"' EXIT
podman build --build-arg "FIXTURE_USER=$(id -un)" --build-arg "FIXTURE_UID=$(id -u)" --build-arg "FIXTURE_GID=$(id -g)" -t "$fixture_image" -f tests/fixtures/ssh/Containerfile tests/fixtures/ssh
cat > "$fixture_root/sshd" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
config=
previous=
for argument in "$@"; do
  if [[ "$previous" == -f ]]; then config=$argument; fi
  previous=$argument
done
root=$(dirname "$config")
exec podman run --rm --network=host --userns=keep-id --user "$(id -u):$(id -g)" \
  -v "$root:$root:rw" localhost/issue-pilot-ssh-fixture:local /usr/sbin/sshd "$@"
WRAPPER
chmod 700 "$fixture_root/sshd"
ISSUE_PILOT_TEST_SSHD="$fixture_root/sshd" node --experimental-strip-types --test tests/workspace/ssh-transport.test.ts
