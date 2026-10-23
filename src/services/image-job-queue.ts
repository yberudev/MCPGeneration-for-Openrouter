import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError, sanitizeErrorMessage } from '../utils/errors.js';
import type { OpenRouterImageRequest } from '../types/openrouter.js';

export type ImageJobStatus =
  'queued' | 'running' | 'completed' | 'failed' | 'uncertain' | 'reconciliation_required';

export interface ImageJobPayload {
  operation: 'generate_image' | 'edit_image' | 'generate_variations';
  model: string;
  prompt: string;
  requestBodies: OpenRouterImageRequest[];
  outputDir?: string;
  outputRoot: string;
  resolvedOutputDir: string;
  filename?: string;
  sourcePath?: string;
  relatedAssetId?: string;
  estimateUsd: number | null;
  estimateSource: string;
  estimateUnknownCost: boolean;
  maxCostUsd: number;
  maxCostPerRequestUsd: number;
  maxTotalSpendUsd: number;
  allowUnknownCost: boolean;
  expectedOutputCount: number;
}

export interface PersistedImageOutput {
  index: number;
  mimeType: string;
  bytes: Buffer;
  sha256: string;
}

export interface ImageJob {
  id: string;
  requestId: string;
  fingerprint: string;
  status: ImageJobStatus;
  phase: string;
  deliveryState: string;
  financialState: string;
  model: string;
  operation: string;
  createdAt: string;
  updatedAt: string;
  estimateUsd: number | null;
  actualCostUsd: number | null;
  httpStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  files: string[];
  payload: ImageJobPayload;
}

function decodeJob(row: Record<string, unknown>): ImageJob {
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    fingerprint: String(row.fingerprint),
    status: String(row.status) as ImageJobStatus,
    phase: String(row.phase),
    deliveryState: String(row.delivery_state),
    financialState: String(row.financial_state),
    model: String(row.model),
    operation: String(row.operation),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    estimateUsd: row.estimate_usd === null ? null : Number(row.estimate_usd),
    actualCostUsd: row.actual_cost_usd === null ? null : Number(row.actual_cost_usd),
    httpStatus: row.http_status === null ? null : Number(row.http_status),
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    files: JSON.parse(String(row.files_json)) as string[],
    payload: JSON.parse(String(row.payload_json)) as ImageJobPayload,
  };
}

/** SQLite is the local, durable IPC queue shared by stdio adapters and the standalone worker. */
export class ImageJobQueue {
  readonly databasePath: string;
  private readonly db: DatabaseSync;

  constructor(readonly dataDir: string) {
    this.databasePath = join(dataDir, 'image-jobs.sqlite');
    this.db = new DatabaseSync(this.databasePath, { timeout: 5_000 });
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.dataDir, 0o700);
    process.umask(0o077);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS image_jobs (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        delivery_state TEXT NOT NULL,
        financial_state TEXT NOT NULL,
        model TEXT NOT NULL,
        operation TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        estimate_usd REAL,
        actual_cost_usd REAL,
        http_status INTEGER,
        error_code TEXT,
        error_message TEXT,
        files_json TEXT NOT NULL DEFAULT '[]',
        payload_json TEXT NOT NULL,
        response_received_at TEXT
      );
      CREATE INDEX IF NOT EXISTS image_jobs_status_created ON image_jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS image_jobs_fingerprint ON image_jobs(fingerprint, status);
      CREATE TABLE IF NOT EXISTS image_job_outputs (
        job_id TEXT NOT NULL REFERENCES image_jobs(id),
        call_index INTEGER NOT NULL,
        output_index INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        bytes BLOB NOT NULL,
        PRIMARY KEY(job_id, call_index, output_index)
      );
      CREATE TABLE IF NOT EXISTS image_job_calls (
        job_id TEXT NOT NULL REFERENCES image_jobs(id),
        call_index INTEGER NOT NULL,
        state TEXT NOT NULL,
        actual_cost_usd REAL,
        http_status INTEGER,
        PRIMARY KEY(job_id, call_index)
      );
      CREATE TABLE IF NOT EXISTS image_job_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES image_jobs(id),
        at TEXT NOT NULL,
        phase TEXT NOT NULL,
        event TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}'
      );
    `);
    await chmod(this.databasePath, 0o600);
    await chmod(`${this.databasePath}-wal`, 0o600).catch(() => undefined);
    await chmod(`${this.databasePath}-shm`, 0o600).catch(() => undefined);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      for (const path of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
        try {
          chmodSync(path, 0o600);
        } catch {
          /* SQLite may not have created the sidecar yet. */
        }
      }
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private event(jobId: string, phase: string, event: string, details: Record<string, unknown> = {}): void {
    this.db
      .prepare('INSERT INTO image_job_events(job_id, at, phase, event, details_json) VALUES (?, ?, ?, ?, ?)')
      .run(jobId, new Date().toISOString(), phase, event, JSON.stringify(details));
  }

  enqueue(payload: ImageJobPayload, fingerprintInput: unknown): { job: ImageJob; duplicate: boolean } {
    const fingerprint = createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('hex');
    return this.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT * FROM image_jobs WHERE fingerprint = ?
           AND status IN ('queued', 'running', 'uncertain', 'reconciliation_required')
           ORDER BY created_at LIMIT 1`,
        )
        .get(fingerprint) as Record<string, unknown> | undefined;
      if (existing) return { job: decodeJob(existing), duplicate: true };
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO image_jobs
           (id, request_id, fingerprint, status, phase, delivery_state, financial_state, model, operation,
            created_at, updated_at, estimate_usd, payload_json)
           VALUES (?, ?, ?, 'queued', 'accepted_local', 'not_started', 'not_reserved', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          id,
          fingerprint,
          payload.model,
          payload.operation,
          now,
          now,
          payload.estimateUsd,
          JSON.stringify(payload),
        );
      this.event(id, 'accepted_local', 'job_queued');
      return { job: this.get(id)!, duplicate: false };
    });
  }

  get(id: string): ImageJob | undefined {
    const row = this.db.prepare('SELECT * FROM image_jobs WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return row ? decodeJob(row) : undefined;
  }

  list(status?: ImageJobStatus, limit = 50): ImageJob[] {
    const rows = status
      ? this.db
          .prepare('SELECT * FROM image_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?')
          .all(status, limit)
      : this.db.prepare('SELECT * FROM image_jobs ORDER BY created_at DESC LIMIT ?').all(limit);
    return (rows as Record<string, unknown>[]).map(decodeJob);
  }

  events(jobId: string): Array<{ at: string; phase: string; event: string; details: unknown }> {
    return (
      this.db
        .prepare(
          'SELECT at, phase, event, details_json FROM image_job_events WHERE job_id = ? ORDER BY sequence',
        )
        .all(jobId) as Array<Record<string, unknown>>
    ).map((row) => ({
      at: String(row.at),
      phase: String(row.phase),
      event: String(row.event),
      details: JSON.parse(String(row.details_json)) as unknown,
    }));
  }

  recoverAfterRestart(): string[] {
    const uncertainIds: string[] = [];
    this.transaction(() => {
      const running = this.db.prepare("SELECT * FROM image_jobs WHERE status = 'running'").all() as Record<
        string,
        unknown
      >[];
      for (const row of running) {
        const id = String(row.id);
        const phase = String(row.phase);
        const now = new Date().toISOString();
        const unfinishedPost = this.db
          .prepare("SELECT 1 FROM image_job_calls WHERE job_id=? AND state='post_started' LIMIT 1")
          .get(String(row.id));
        if (phase === 'post_started' || unfinishedPost) {
          uncertainIds.push(id);
          this.db
            .prepare(
              `UPDATE image_jobs SET status='uncertain', phase='uncertain_after_post',
               delivery_state='unknown', financial_state='uncertain', error_code='WORKER_RESTART_AFTER_POST',
               error_message='Worker reiniciado após o início possível do POST; não será repetido automaticamente.', updated_at=? WHERE id=?`,
            )
            .run(now, id);
          this.event(id, 'uncertain_after_post', 'worker_restart_uncertain');
        } else if (phase === 'result_parsed' || phase === 'files_persisted' || phase === 'cost_accounted') {
          this.db.prepare("UPDATE image_jobs SET status='queued', updated_at=? WHERE id=?").run(now, id);
          this.event(id, phase, 'worker_restart_resume_delivery');
        } else {
          this.db.prepare("UPDATE image_jobs SET status='queued', updated_at=? WHERE id=?").run(now, id);
          this.event(id, 'accepted_local', 'worker_restart_before_post_requeued');
        }
      }
      const alreadyUncertain = this.db
        .prepare("SELECT id FROM image_jobs WHERE status='uncertain' AND financial_state='uncertain'")
        .all() as Array<{ id: string }>;
      for (const item of alreadyUncertain) uncertainIds.push(String(item.id));
    });
    return [...new Set(uncertainIds)];
  }

  claimNext(): ImageJob | undefined {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM image_jobs WHERE status='queued' ORDER BY created_at LIMIT 1")
        .get() as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const id = String(row.id);
      const oldPhase = String(row.phase);
      const phase = oldPhase === 'accepted_local' ? 'preflight' : oldPhase;
      this.db
        .prepare(
          "UPDATE image_jobs SET status='running', phase=?, updated_at=? WHERE id=? AND status='queued'",
        )
        .run(phase, new Date().toISOString(), id);
      this.event(id, phase, 'job_claimed');
      return this.get(id);
    });
  }

  setPhase(jobId: string, phase: string, deliveryState?: string, financialState?: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE image_jobs SET phase=?, delivery_state=COALESCE(?, delivery_state),
           financial_state=COALESCE(?, financial_state), updated_at=? WHERE id=?`,
        )
        .run(phase, deliveryState ?? null, financialState ?? null, new Date().toISOString(), jobId);
      this.event(jobId, phase, 'phase_changed');
    });
  }

  callState(jobId: string, callIndex: number): string | undefined {
    const row = this.db
      .prepare('SELECT state FROM image_job_calls WHERE job_id=? AND call_index=?')
      .get(jobId, callIndex) as { state: string } | undefined;
    return row?.state;
  }

  markCallPostStarted(jobId: string, callIndex: number): void {
    this.transaction(() => {
      const state = this.callState(jobId, callIndex);
      if (state === 'response_received') return;
      if (state === 'post_started')
        throw new AppError('Este POST já pode ter sido enviado; não será repetido.', 'IMAGE_POST_UNCERTAIN');
      this.db
        .prepare(
          `INSERT INTO image_job_calls(job_id, call_index, state) VALUES (?, ?, 'post_started')
           ON CONFLICT(job_id, call_index) DO UPDATE SET state='post_started'`,
        )
        .run(jobId, callIndex);
      this.db
        .prepare(
          "UPDATE image_jobs SET phase='post_started', delivery_state='post_may_have_been_sent', updated_at=? WHERE id=?",
        )
        .run(new Date().toISOString(), jobId);
      this.event(jobId, 'post_started', 'paid_post_about_to_start', { callIndex });
    });
  }

  recordHttpStatus(jobId: string, status: number): void {
    this.transaction(() => {
      this.db
        .prepare('UPDATE image_jobs SET http_status=?, updated_at=? WHERE id=?')
        .run(status, new Date().toISOString(), jobId);
      this.event(jobId, 'http_response_received', 'http_headers_received', { httpStatus: status });
    });
  }

  saveResponse(
    jobId: string,
    callIndex: number,
    outputs: PersistedImageOutput[],
    actualCostUsd: number | null,
    httpStatus = 200,
  ): void {
    this.transaction(() => {
      const exists = this.db.prepare('SELECT id FROM image_jobs WHERE id=?').get(jobId);
      if (!exists) throw new AppError('Job de imagem inexistente.', 'IMAGE_JOB_NOT_FOUND');
      const insert = this.db.prepare(
        'INSERT OR REPLACE INTO image_job_outputs(job_id, call_index, output_index, mime_type, sha256, bytes) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const output of outputs)
        insert.run(jobId, callIndex, output.index, output.mimeType, output.sha256, output.bytes);
      this.db
        .prepare(
          `INSERT INTO image_job_calls(job_id, call_index, state, actual_cost_usd, http_status)
           VALUES (?, ?, 'response_received', ?, ?)
           ON CONFLICT(job_id, call_index) DO UPDATE SET state='response_received', actual_cost_usd=excluded.actual_cost_usd, http_status=excluded.http_status`,
        )
        .run(jobId, callIndex, actualCostUsd, httpStatus);
      const costRow = this.db
        .prepare(
          'SELECT COUNT(*) AS count, SUM(actual_cost_usd) AS total, SUM(actual_cost_usd IS NULL) AS missing FROM image_job_calls WHERE job_id=?',
        )
        .get(jobId) as { count: number; total: number | null; missing: number };
      const payloadRow = this.db.prepare('SELECT payload_json FROM image_jobs WHERE id=?').get(jobId) as
        { payload_json: string } | undefined;
      const expectedCalls = payloadRow
        ? (JSON.parse(payloadRow.payload_json) as ImageJobPayload).requestBodies.length
        : 0;
      this.db
        .prepare(
          `UPDATE image_jobs SET phase='result_parsed', delivery_state='response_persisted',
           actual_cost_usd=?, http_status=?, updated_at=? WHERE id=?`,
        )
        .run(
          costRow.count === expectedCalls && costRow.missing === 0 ? costRow.total : null,
          httpStatus,
          new Date().toISOString(),
          jobId,
        );
      this.event(jobId, 'response_received', 'http_response_received', {
        httpStatus,
        actualCostKnown: actualCostUsd !== null,
      });
      this.event(jobId, 'result_parsed', 'response_outputs_durably_stored', {
        outputCount: outputs.length,
        callIndex,
        httpStatus,
        outputBytes: outputs.reduce((sum, output) => sum + output.bytes.length, 0),
      });
    });
  }

  outputs(jobId: string): PersistedImageOutput[] {
    return (
      this.db
        .prepare(
          'SELECT output_index, mime_type, sha256, bytes FROM image_job_outputs WHERE job_id=? ORDER BY call_index, output_index',
        )
        .all(jobId) as Array<Record<string, unknown>>
    ).map((row) => ({
      index: Number(row.output_index),
      mimeType: String(row.mime_type),
      sha256: String(row.sha256),
      bytes: Buffer.from(row.bytes as Uint8Array),
    }));
  }

  allCallsReceived(jobId: string, expectedCount: number): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM image_job_calls WHERE job_id=? AND state='response_received'")
      .get(jobId) as { count: number };
    return row.count === expectedCount;
  }

  allCallsReceivedForJob(job: ImageJob): boolean {
    return this.allCallsReceived(job.id, job.payload.requestBodies.length);
  }

  confirmedCalls(jobId: string): { count: number; totalCostUsd: number; allCostsKnown: boolean } {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count, COALESCE(SUM(actual_cost_usd), 0) AS total, SUM(actual_cost_usd IS NULL) AS missing FROM image_job_calls WHERE job_id=? AND state='response_received'",
      )
      .get(jobId) as { count: number; total: number; missing: number | null };
    return {
      count: row.count,
      totalCostUsd: Number(row.total),
      allCostsKnown: row.count > 0 && row.missing === 0,
    };
  }

  setActualCost(jobId: string, costUsd: number | null): void {
    this.transaction(() => {
      this.db
        .prepare('UPDATE image_jobs SET actual_cost_usd=?, updated_at=? WHERE id=?')
        .run(costUsd, new Date().toISOString(), jobId);
      this.event(jobId, 'cost_accounted', 'actual_cost_recorded', { known: costUsd !== null });
    });
  }

  httpStatus(jobId: string): number | null {
    const row = this.db.prepare('SELECT http_status FROM image_jobs WHERE id=?').get(jobId) as
      { http_status: number | null } | undefined;
    return row?.http_status ?? null;
  }

  finish(jobId: string, files: string[]): void {
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE image_jobs SET status='completed', phase='completed', delivery_state='delivered',
           financial_state=CASE WHEN actual_cost_usd IS NULL THEN 'cost_unknown' ELSE 'accounted' END,
           files_json=?, updated_at=?, error_code=NULL, error_message=NULL WHERE id=?`,
        )
        .run(JSON.stringify(files), new Date().toISOString(), jobId);
      this.event(jobId, 'completed', 'all_outputs_persisted', { fileCount: files.length });
    });
  }

  fail(jobId: string, code: string, message: string, httpStatus: number | null): void {
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE image_jobs SET status='failed', phase='failed', delivery_state='failed',
           financial_state='released', error_code=?, error_message=?, http_status=?, updated_at=? WHERE id=?`,
        )
        .run(code.slice(0, 100), sanitizeErrorMessage(message), httpStatus, new Date().toISOString(), jobId);
      this.event(jobId, 'failed', 'pre_delivery_failure', { code: code.slice(0, 100), httpStatus });
    });
  }

  uncertain(jobId: string, code: string, message: string, httpStatus: number | null): void {
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE image_jobs SET status='uncertain', phase='uncertain', delivery_state='unknown',
           financial_state='uncertain', error_code=?, error_message=?, http_status=?, updated_at=? WHERE id=?`,
        )
        .run(code.slice(0, 100), sanitizeErrorMessage(message), httpStatus, new Date().toISOString(), jobId);
      this.event(jobId, 'uncertain', 'post_outcome_uncertain', { code: code.slice(0, 100), httpStatus });
    });
  }

  deliveryFailure(jobId: string, code: string, message: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE image_jobs SET status='reconciliation_required', phase='delivery_failed',
           delivery_state='failed_after_response', error_code=?, error_message=?, updated_at=? WHERE id=?`,
        )
        .run(code.slice(0, 100), sanitizeErrorMessage(message), new Date().toISOString(), jobId);
      this.event(jobId, 'delivery_failed', 'response_received_but_file_not_delivered', {
        code: code.slice(0, 100),
      });
    });
  }

  partialFailure(
    jobId: string,
    files: string[],
    code: string,
    message: string,
    httpStatus: number,
    financialState: 'accounted' | 'cost_unknown',
  ): void {
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE image_jobs SET status='failed', phase='partial_completed', delivery_state='partial',
           financial_state=?, files_json=?, error_code=?, error_message=?, http_status=?, updated_at=? WHERE id=?`,
        )
        .run(
          financialState,
          JSON.stringify(files),
          code.slice(0, 100),
          sanitizeErrorMessage(message),
          httpStatus,
          new Date().toISOString(),
          jobId,
        );
      this.event(jobId, 'partial_completed', 'partial_outputs_delivered', {
        fileCount: files.length,
        code,
        httpStatus,
      });
    });
  }

  reconcile(
    jobId: string,
    decision: 'confirm_charged' | 'confirm_not_charged',
    evidence: string,
    actualCostUsd?: number,
  ): void {
    if (evidence.trim().length < 8)
      throw new AppError(
        'A reconciliação exige uma nota de evidência (mínimo 8 caracteres).',
        'RECONCILIATION_EVIDENCE_REQUIRED',
      );
    if (
      decision === 'confirm_charged' &&
      (actualCostUsd === undefined || !Number.isFinite(actualCostUsd) || actualCostUsd < 0)
    )
      throw new AppError(
        'Para confirmar uma cobrança, indique o custo real verificado.',
        'RECONCILIATION_COST_REQUIRED',
      );
    this.transaction(() => {
      const row = this.db.prepare('SELECT status, payload_json FROM image_jobs WHERE id=?').get(jobId) as
        { status: string; payload_json: string } | undefined;
      if (!row) throw new AppError('Job de imagem inexistente.', 'IMAGE_JOB_NOT_FOUND');
      if (!['uncertain', 'reconciliation_required'].includes(row.status))
        throw new AppError('Este job não requer reconciliação.', 'IMAGE_JOB_NOT_RECONCILABLE');
      const payload = JSON.parse(row.payload_json) as ImageJobPayload;
      const canResumeDelivery =
        decision === 'confirm_charged' &&
        this.outputs(jobId).length >= payload.expectedOutputCount &&
        this.allCallsReceived(jobId, payload.requestBodies.length);
      this.db
        .prepare(
          `UPDATE image_jobs SET status=?, phase=?, financial_state=?, actual_cost_usd=COALESCE(?, actual_cost_usd), updated_at=? WHERE id=?`,
        )
        .run(
          canResumeDelivery
            ? 'queued'
            : decision === 'confirm_charged'
              ? 'reconciliation_required'
              : 'failed',
          canResumeDelivery ? 'cost_accounted' : 'reconciled',
          decision === 'confirm_charged' ? 'accounted_by_reconciliation' : 'released_by_reconciliation',
          actualCostUsd ?? null,
          new Date().toISOString(),
          jobId,
        );
      this.event(jobId, 'reconciled', decision, {
        evidence: sanitizeErrorMessage(evidence),
        actualCostUsd: actualCostUsd ?? null,
      });
    });
  }

  close(): void {
    this.db.close();
  }
}
