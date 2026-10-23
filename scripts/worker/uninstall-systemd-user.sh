#!/usr/bin/env bash
set -euo pipefail

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/mcp-generation-image-worker.service"
systemctl --user disable --now mcp-generation-image-worker.service 2>/dev/null || true
rm -f "$UNIT_PATH"
systemctl --user daemon-reload
printf 'Worker service removed. Queue and financial history were preserved.\n'
