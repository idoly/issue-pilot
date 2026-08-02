#!/bin/sh
set -eu

config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
quadlet_home="$config_home/containers/systemd"
issue_config="$config_home/issue-agent"
env_source="${1:-$(dirname "$0")/../.env}"

if [ ! -f "$env_source" ]; then
  printf 'Environment file not found: %s\n' "$env_source" >&2
  printf 'Create it from infra/.env.example and use strong secrets.\n' >&2
  exit 1
fi

mkdir -p "$quadlet_home" "$issue_config"
install -m 600 "$env_source" "$issue_config/env"
install -m 700 "$(dirname "$0")/../postgres/init-databases.sh" "$issue_config/init-databases.sh"
install -m 644 "$(dirname "$0")"/*.container "$(dirname "$0")"/*.network "$(dirname "$0")"/*.volume "$quadlet_home/"

systemctl --user daemon-reload
systemctl --user enable --now issue-agent-postgres.service issue-agent-keycloak.service
