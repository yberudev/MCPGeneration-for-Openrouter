#!/usr/bin/env bash
set -euo pipefail
exec journalctl --user -u mcp-generation-image-worker.service --since today --no-pager "$@"
