import { randomUUID } from 'node:crypto';
import { AppError, sanitizeErrorMessage } from '../utils/errors.js';
import type { MetadataStore } from './metadata-store.js';
import { type VideoJobRecord, type VideoJobStatus } from './metadata-store.js';
import type { VideoJobResponse } from '../types/openrouter.js';

export function normalizeVideoStatus(status: string | undefined): VideoJobStatus {
  const normalized = status?.toLowerCase().replace(/[ -]/g, '_');
  if (!normalized) return 'unknown';
  if (['queued', 'submitted', 'created'].includes(normalized)) return 'pending';
  if (['processing', 'running', 'in_progress'].includes(normalized)) return 'in_progress';
  if (['succeeded', 'success', 'done'].includes(normalized)) return 'completed';
  if (normalized === 'error') return 'failed';
  return normalized;
}

export class JobManager {
  constructor(private readonly store: MetadataStore) {}

  async create(args: {
    remote: VideoJobResponse;
    model: string;
    prompt: string;
    config: Record<string, unknown>;
    outputDir?: string;
    filename?: string;
  }): Promise<VideoJobRecord> {
    if (typeof args.remote.id !== 'string' || !args.remote.id.trim()) {
      throw new AppError(
        'A API aceitou o pedido, mas não devolveu um identificador remoto de tarefa. Consulte a atividade OpenRouter antes de repetir.',
        'MISSING_VIDEO_JOB_ID',
      );
    }
    const now = new Date().toISOString();
    const job: VideoJobRecord = {
      id: randomUUID(),
      remoteId: args.remote.id,
      model: args.model,
      prompt: args.prompt,
      status: normalizeVideoStatus(args.remote.status),
      createdAt: now,
      updatedAt: now,
      costUsd: typeof args.remote.usage?.cost === 'number' ? args.remote.usage.cost : null,
      ...(args.remote.error ? { error: sanitizeErrorMessage(args.remote.error) } : {}),
      ...(args.outputDir ? { outputDir: args.outputDir } : {}),
      ...(args.filename ? { filename: args.filename } : {}),
      config: args.config,
      files: [],
    };
    await this.store.saveJob(job);
    return job;
  }

  async require(id: string): Promise<VideoJobRecord> {
    const job = await this.store.getJob(id);
    if (!job) throw new AppError(`Tarefa local não encontrada: ${id}`, 'JOB_NOT_FOUND');
    return job;
  }

  async update(job: VideoJobRecord, response: VideoJobResponse): Promise<VideoJobRecord> {
    if (typeof response.status !== 'string' || !response.status.trim()) {
      throw new AppError(
        'A resposta de estado do OpenRouter não contém um campo status válido.',
        'INVALID_VIDEO_STATUS',
      );
    }
    const next: VideoJobRecord = {
      ...job,
      status: normalizeVideoStatus(response.status),
      updatedAt: new Date().toISOString(),
      ...(typeof response.usage?.cost === 'number' ? { costUsd: response.usage.cost } : {}),
      ...(response.error ? { error: sanitizeErrorMessage(response.error) } : {}),
    };
    await this.store.saveJob(next);
    return next;
  }
}
