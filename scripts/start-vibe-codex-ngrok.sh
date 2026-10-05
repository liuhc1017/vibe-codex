#!/usr/bin/env bash
set -euo pipefail

export PATH="${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
script_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
repo_dir="${VIBE_CODEX_REPO_DIR:-$(dirname -- "$script_dir")}"
cd -- "$repo_dir"
log_dir="$repo_dir/.vibe-codex/launchd"
mkdir -p -- "$log_dir"
node_bin="${NODE_BIN:-$(command -v node || true)}"
ngrok_bin="${NGROK_BIN:-$(command -v ngrok || true)}"
if [[ -z "$node_bin" || -z "$ngrok_bin" ]]; then
  printf '%s\n' 'Node.js and ngrok are required. Set NODE_BIN/NGROK_BIN or add them to PATH.' >&2
  exit 1
fi
now() { date "+%Y-%m-%dT%H:%M:%S%z"; }

# Parse dotenv as data, never execute its contents. Existing env vars take precedence.
config_output="$("$node_bin" --input-type=module <<'NODE'
import dotenv from 'dotenv';
dotenv.config();
try {
  const url = new URL(process.env.PUBLIC_BASE_URL ?? '');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('PUBLIC_BASE_URL must be an HTTP(S) URL without credentials.');
  const value = process.env.PORT ?? '8787';
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('PORT must be between 1 and 65535.');
  console.log(url.origin);
  console.log(Number(value));
} catch (error) {
  console.error('Invalid tunnel configuration:', error.message);
  process.exit(1);
}
NODE
)"
public_base_url="${config_output%%$'\n'*}"
relay_port="${config_output##*$'\n'}"

ready=false
for ((attempt=1; attempt<=60; attempt++)); do
  if curl --http1.1 --connect-timeout 1 --max-time 2 -fsS "http://127.0.0.1:$relay_port/health" >/dev/null 2>&1; then
    ready=true
    break
  fi
  printf '[%s] waiting for Vibe Codex on 127.0.0.1:%s attempt=%s\n' "$(now)" "$relay_port" "$attempt" >> "$log_dir/ngrok-bootstrap.log"
  sleep 1
done
if [[ "$ready" != true ]]; then
  printf '[%s] Vibe Codex did not become ready; ngrok will retry via launchd\n' "$(now)" >> "$log_dir/ngrok-bootstrap.log"
  exit 1
fi
printf '[%s] starting ngrok for %s -> %s\n' "$(now)" "$public_base_url" "$relay_port" >> "$log_dir/ngrok-bootstrap.log"
exec "$ngrok_bin" http "--url=$public_base_url" "http://127.0.0.1:$relay_port"
