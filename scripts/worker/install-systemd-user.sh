#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_BIN="$(command -v node)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/mcp-generation-image-worker.service"
SECRET_ENV="${XDG_CONFIG_HOME:-$HOME/.config}/mcp-generation/worker.env"

"$REPO_ROOT/scripts/worker/prepare-env.sh"
if [[ ! -f "$SECRET_ENV" ]] || ! grep -qE '^OPENROUTER_API_KEY=.+$' "$SECRET_ENV"; then
  echo "Create $SECRET_ENV with OPENROUTER_API_KEY before installing the paid image worker." >&2
  exit 1
fi
chmod 600 "$SECRET_ENV"

cd "$REPO_ROOT"
npm run build
DATA_DIR="$(node --input-type=module -e "import('./dist/config/env.js').then(({loadConfig}) => console.log(loadConfig().dataDir))")"
mkdir -p "$DATA_DIR" "$UNIT_DIR"
chmod 700 "$DATA_DIR" "$UNIT_DIR"

# Keep untouched, timestamped copies before activating the worker alongside the legacy JSON store.
BACKUP_DIR="$DATA_DIR/pre-image-worker-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$BACKUP_DIR"
for name in requests.json usage.json assets.json jobs.json; do
  if [[ -f "$DATA_DIR/$name" ]]; then
    cp --preserve=mode,timestamps "$DATA_DIR/$name" "$BACKUP_DIR/$name"
  fi
done
printf 'Legacy metadata snapshots: %s\n' "$BACKUP_DIR"

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=MCPGeneration durable image generation worker
After=default.target

[Service]
Type=simple
WorkingDirectory=$REPO_ROOT
ExecStart=$NODE_BIN $REPO_ROOT/dist/image-worker.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=300
UMask=0077
Environment=NODE_ENV=production
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF
chmod 600 "$UNIT_PATH"
systemctl --user daemon-reload
systemctl --user enable --now mcp-generation-image-worker.service
systemctl --user --no-pager status mcp-generation-image-worker.service
