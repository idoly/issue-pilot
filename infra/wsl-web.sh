#!/bin/sh
set -eu

state_root=$(realpath -m "${ISSUE_PILOT_STATE_ROOT:-.issue-pilot}")
tls_root="$state_root/tls"
ip_file="$tls_root/wsl-ip"
password_file="$tls_root/password"
pfx_file="$tls_root/issue-pilot.pfx"
cer_file="$tls_root/issue-pilot.cer"
wsl_ip=${ISSUE_PILOT_WSL_IP:-$(ip -4 -o addr show dev eth0 scope global | awk 'NR == 1 { split($4, address, "/"); print address[1] }')}

[ -n "$wsl_ip" ] || { printf 'Unable to determine the WSL IPv4 address\n' >&2; exit 1; }
mkdir -p "$tls_root"
chmod 0700 "$tls_root"

current_ip=$(cat "$ip_file" 2>/dev/null || true)
if [ "$current_ip" != "$wsl_ip" ] || [ ! -s "$pfx_file" ] || [ ! -s "$password_file" ]; then
  umask 077
  head -c 32 /dev/urandom | base64 > "$password_file"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w infra/wsl-https.ps1)" \
    -IpAddress "$wsl_ip" \
    -PfxPath "$(wslpath -w "$pfx_file")" \
    -CerPath "$(wslpath -w "$cer_file")" \
    -Password "$(cat "$password_file")" >/dev/null
  printf '%s\n' "$wsl_ip" > "$ip_file"
  chmod 0600 "$password_file" "$pfx_file" "$cer_file" "$ip_file"
  printf 'Install the Windows trust certificate once: %s\n' "$(wslpath -w "$cer_file")"
fi

printf 'Issue Pilot: https://%s:4173/\n' "$wsl_ip"
exec env \
  ISSUE_PILOT_WEB_HOST="$wsl_ip" \
  ISSUE_PILOT_WEB_TLS_PFX="$pfx_file" \
  ISSUE_PILOT_WEB_TLS_PASSPHRASE="$(cat "$password_file")" \
  node_modules/.bin/vite --config src/web/vite.config.ts
