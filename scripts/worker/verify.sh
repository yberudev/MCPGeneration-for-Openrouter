#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
node --version
test -f dist/index.js || { echo 'dist/index.js missing; run npm run build' >&2; exit 1; }
test -f dist/image-worker.js || { echo 'dist/image-worker.js missing; run npm run build' >&2; exit 1; }
DATA_DIR="$(node --input-type=module -e "import('./dist/config/env.js').then(({loadConfig}) => console.log(loadConfig().dataDir))")"
printf 'Data directory: %s\n' "$DATA_DIR"
if [[ -d "$DATA_DIR" ]]; then stat -c 'directory mode: %a' "$DATA_DIR"; fi
if [[ -f "$DATA_DIR/image-jobs.sqlite" ]]; then stat -c 'database mode: %a, size: %s bytes' "$DATA_DIR/image-jobs.sqlite"; fi
systemctl --user --no-pager status mcp-generation-image-worker.service || true
if [[ -f "$DATA_DIR/image-jobs.sqlite" ]]; then
  node --input-type=module - "$DATA_DIR/image-jobs.sqlite" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const rows = db.prepare('SELECT status, COUNT(*) AS count FROM image_jobs GROUP BY status ORDER BY status').all();
console.log('Image job counts:', JSON.stringify(rows));
db.close();
NODE
fi
