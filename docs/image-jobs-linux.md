# Image jobs: Linux operation and recovery

## Architecture

Image tools in the Claude stdio process validate the current OpenRouter image catalog, validate local paths and costs, then commit a job to `image-jobs.sqlite`. The MCP response returns `job_id`; no image POST runs in that process. The standalone Node worker polls the same database and runs under `systemd --user`, so an MCP cancellation, Claude restart or project switch does not cancel a claimed job.

SQLite WAL is the local IPC channel. It avoids a listening network service and keeps the durable queue, request payload, response bytes, output hashes, events and phases in one transactional store. The directory is mode `0700`; SQLite database/WAL/SHM files are mode `0600`. Writes use `BEGIN IMMEDIATE`, `synchronous=FULL`, a busy timeout, a single-worker lock and a unique active fingerprint. This keeps operations recoverable across concurrent MCP connections and prevents duplicate queue entries. A Unix socket was not added: the queue database itself is the local IPC boundary and is protected by OS file permissions.

The worker flow is:

1. Claim a `queued` job and validate the destination again.
2. Atomically reserve the estimated budget through the existing locked metadata store, using `job_id` as the stable request ID.
3. Commit `post_started` durably before the one paid POST. There is no POST retry.
4. Record `http_response_received` and its status when response headers arrive. After validating the body and image bytes, commit `result_parsed` and outputs to SQLite.
5. Record actual cost (or `null` with an unknown-cost block), write each image to a temporary file, `fsync`, link it atomically into place, `fsync` the directory, persist metadata and verify SHA-256.
6. Set `completed` only after every expected image is present and verified.

Delivery (`delivery_state`) and finance (`financial_state`) are separate. A known charge with a failed local write becomes `reconciliation_required`; it is never presented as delivered. If cost is absent, the system records `null`, retains the conservative estimate and blocks later spending until explicit reconciliation.

## States and restart rules

`queued`, `running`, `completed`, `failed`, `uncertain` and `reconciliation_required` are persisted in SQLite. Events include request/job IDs, phase, model, HTTP status, duration and sanitized errors; prompts, API keys and base64 are excluded.

- Before `post_started`, worker recovery returns the job to `queued`. The stable reservation ID makes an already-written reservation idempotent.
- After `post_started` without durably stored output bytes, recovery changes the job and financial reservation to `uncertain`, even if an HTTP status was recorded. The worker will never send that POST again.
- After a response is durable, recovery can continue cost accounting and file delivery without another POST.
- A definitive OpenRouter 4xx before any successful call releases the reservation. 5xx, timeout, connection reset, invalid response or oversized response are conservative `uncertain` outcomes.
- `reconcile_image_job` records evidence and a decision. `confirm_charged` requires the verified actual cost; `confirm_not_charged` releases the reservation. Neither choice automatically retries or deletes the job. If response bytes are still durable, a confirmed charge can resume local file delivery.

OpenRouter's [generation metadata endpoint](https://openrouter.ai/docs/api/api-reference/generations/get-generation) and [generation content endpoint](https://openrouter.ai/docs/api/api-reference/generations/list-generation-content) expose generation records/content; neither guarantees recovery of the binary image returned in the synchronous [`/images` response](https://openrouter.ai/blog/tutorials/image-generation/). A lost response after an uncertain POST may therefore be irrecoverable. The MCP must report the uncertainty rather than promise the image can be downloaded later.

## Install and verify

The image worker uses the repository's `.env` only as a development fallback. Keep the production API key outside the repository:

```bash
install -d -m 700 ~/.config/mcp-generation
nano ~/.config/mcp-generation/worker.env
chmod 600 ~/.config/mcp-generation/worker.env
```

Put `OPENROUTER_API_KEY=<your key>` in that file without committing it. The inherited process environment takes precedence; otherwise this external file loads before the repository `.env`. Do not put a key in a checked-in `.mcp.json`.

Install/update the worker service:

```bash
cd /home/yberudev/Documentos/MCPGeneration
npm ci
npm run build
scripts/worker/install-systemd-user.sh
scripts/worker/verify.sh
```

The installer takes a timestamped copy of existing `requests.json`, `usage.json`, `assets.json` and `jobs.json` before enabling the service. It does not migrate, delete or reconcile those records. The service uses the `.env`-resolved `YBERU_DATA_DIR` (default `~/.local/share/mcp-generation-openrouter`) and the worker executable built in this checkout. Configure `YBERU_PROJECT_ROOT`/`YBERU_ALLOWED_ROOTS` for the MCP adapter as usual; the adapter validates each destination before enqueuing and stores its authorized root with the private local job.

Handy operations:

```bash
systemctl --user status mcp-generation-image-worker.service
systemctl --user restart mcp-generation-image-worker.service
scripts/worker/logs.sh -f
scripts/worker/verify.sh
scripts/worker/uninstall-systemd-user.sh
```

Uninstall removes only the systemd unit. It deliberately leaves SQLite, legacy JSON, backups and output assets intact. To keep a user service alive without an interactive login, configure systemd lingering for that account according to the host's policy.

## Day-to-day checks

Use `list_image_jobs` for queued/running/failed/completed/uncertain jobs and legacy reservations; use `get_image_job_status` for a single job's phase, cost, errors, audit events and file paths. A job that stays queued is not a reason to create another job: check `systemctl --user status` and the worker logs first.

The MCP process returns `job_id` before the image response, so the Claude client's observed ~60-second tool-call cancellation is no longer the image-generation lifetime. The installed Claude Desktop configuration had no explicit MCP timeout value, so that observation is a client/runtime behavior rather than a configured server timeout. Distinguish:

- **MCP call cancellation:** only the short enqueue/status call ends; the worker continues.
- **stdio server exit:** the adapter process closes; the independent worker and SQLite job remain.
- **HTTP failure/timeout:** the worker's configured `HTTP_TIMEOUT_MS` applies. If a paid POST may have reached OpenRouter without a conclusive response, mark it `uncertain`; do not raise the Claude timeout or retry the generation.

## Incident procedure

1. Do not submit another generation while the existing request is `running`, `uncertain` or `reconciliation_required`.
2. Save the job ID and inspect `get_image_job_status`, `list_image_jobs`, `scripts/worker/verify.sh` and `scripts/worker/logs.sh`.
3. If the response is already in SQLite, restart the worker; it can resume delivery without a POST.
4. If status is `uncertain`, check OpenRouter activity/usage manually. Use `reconcile_image_job` with evidence and the confirmed cost (or confirmed non-charge). Reconciliation does not restore missing image bytes and does not schedule a retry.
5. Preserve the original job and financial history. Do not delete a pending/uncertain JSON reservation based on age.

For a consistent manual backup of the SQLite files, stop the worker first and copy the database plus its sidecars together:

```bash
systemctl --user stop mcp-generation-image-worker.service
backup="$HOME/.local/share/mcp-generation-openrouter/backup-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$backup"
cp -a "$HOME/.local/share/mcp-generation-openrouter/image-jobs.sqlite"* "$backup/"
cp -a "$HOME/.local/share/mcp-generation-openrouter/requests.json" \
  "$HOME/.local/share/mcp-generation-openrouter/usage.json" \
  "$HOME/.local/share/mcp-generation-openrouter/assets.json" "$backup/" 2>/dev/null || true
systemctl --user start mcp-generation-image-worker.service
```

If `YBERU_DATA_DIR` is customized, use that absolute path in the backup commands. Backups contain prompts and input/output image bytes; keep them mode `0700` and off source control.

## Upgrade from the synchronous image tools

Build and restart the user worker, then restart Claude Desktop so it loads the new `dist/index.js` and the new tools. The old tool names remain registered, but `generate_image`, `edit_image` and `generate_variations` now return `{ job_id, status: "queued" }` rather than waiting for `{ files }`; follow them with `get_image_job_status`. Existing video tools and `jobs.json` remain on their existing flow. The image queue is additive and does not migrate or rewrite the pre-existing JSON history.

The initial image job schema has no historical queue to migrate. If a future SQLite schema migration is added, it must first take a consistent SQLite backup as well as copies of all four legacy JSON files; never infer or clear an uncertain request from its age.
