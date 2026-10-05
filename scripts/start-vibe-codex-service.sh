#!/usr/bin/env bash
set -euo pipefail

# Preserve the installer's/user's executable search path (including nvm/asdf),
# with common macOS locations as fallbacks for launchd's minimal environment.
export PATH="${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
script_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
repo_dir="${VIBE_CODEX_REPO_DIR:-$(dirname -- "$script_dir")}"
cd -- "$repo_dir"
log_dir="$repo_dir/.vibe-codex/launchd"
mkdir -p -- "$log_dir"

npm_bin="${NPM_BIN:-$(command -v npm || true)}"
node_bin="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$npm_bin" || -z "$node_bin" ]]; then
  printf '%s\n' 'Node.js and npm are required. Set NODE_BIN/NPM_BIN or add them to PATH.' >&2
  exit 1
fi
# npm uses env node, so make the explicitly configured Node executable discoverable.
export PATH="$(dirname -- "$node_bin"):$PATH"

now() { date "+%Y-%m-%dT%H:%M:%S%z"; }
printf '[%s] building Vibe Codex\n' "$(now)" >> "$log_dir/server-bootstrap.log"
"$npm_bin" run build >> "$log_dir/server-bootstrap.log" 2>&1
printf '[%s] starting Vibe Codex\n' "$(now)" >> "$log_dir/server-bootstrap.log"
# Production authentication and ports come from the inherited environment/.env.
# Never force VIBE_CODEX_DEV or source .env as executable shell code.
exec "$node_bin" dist/src/index.js
