import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as lockfile from 'proper-lockfile';
import { AppError } from '../utils/errors.js';

export interface AssetRecord {
  id: string;
  type: 'image' | 'video';
  path: string;
  root: string;
  relativePath: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  status: 'completed';
  model: string;
  prompt: string;
  createdAt: string;
  costUsd: number | null;
  jobId?: string;
  generationId?: string;
  relatedAssetId?: string;
  relatedAssetPath?: string;
  parameters?: Record<string, unknown>;
}

export type VideoJobStatus =
  'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'expired' | string;

export interface VideoJobRecord {
  id: string;
  remoteId: string;
  model: string;
  prompt: string;
  status: VideoJobStatus;
  createdAt: string;
  updatedAt: string;
  costUsd: number | null;
  error?: string;
  outputDir?: string;
  filename?: string;
  config: Record<string, unknown>;
  files: string[];
}

interface PaidRequestRecord {
  id: string;
  operation: string;
  fingerprint: string;
  createdAt: string;
  state: 'pending' | 'uncertain';
  budgetUsd: number;
  unknownCost: boolean;
  remoteId?: string;
}

export interface PaidRequestSummary {
  id: string;
  operation: string;
  createdAt: string;
  state: 'pending' | 'uncertain';
  budgetUsd: number;
  unknownCost: boolean;
  remoteId?: string;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export class MetadataStore {
  private queue: Promise<void> = Promise.resolve();
  readonly jobsPath: string;
  readonly assetsPath: string;
  readonly usagePath: string;
  readonly requestsPath: string;

  constructor(readonly dataDir: string) {
    this.jobsPath = join(dataDir, 'jobs.json');
    this.assetsPath = join(dataDir, 'assets.json');
    this.usagePath = join(dataDir, 'usage.json');
    this.requestsPath = join(dataDir, 'requests.json');
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
  }

  private async readArray<T>(path: string): Promise<T[]> {
    try {
      const raw = await readFile(path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('expected an array');
      return parsed as T[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new AppError(`Metadados locais inválidos ou ilegíveis: ${path}`, 'METADATA_READ_ERROR', {
        cause: error,
      });
    }
  }

  private async writeArray<T>(path: string, value: T[]): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(temp, 'wx', 0o600);
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temp, path);
      await syncDirectory(dirname(path));
    } catch (error) {
      await file?.close().catch(() => undefined);
      await rm(temp, { force: true }).catch(() => undefined);
      throw new AppError(`Não foi possível gravar metadados locais: ${path}`, 'METADATA_WRITE_ERROR', {
        cause: error,
      });
    }
  }

  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const prior = this.queue;
    let unlock!: () => void;
    this.queue = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await prior;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.dataDir, {
        stale: 30_000,
        update: 10_000,
        retries: { retries: 100, factor: 1.2, minTimeout: 25, maxTimeout: 250, randomize: true },
      });
      return await work();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'Não foi possível adquirir ou manter o bloqueio partilhado dos metadados. Nenhuma reserva foi confirmada.',
        'METADATA_LOCK_ERROR',
        { cause: error },
      );
    } finally {
      try {
        await release?.();
      } finally {
        unlock();
      }
    }
  }

  async jobs(): Promise<VideoJobRecord[]> {
    return this.readArray<VideoJobRecord>(this.jobsPath);
  }
  async assets(): Promise<AssetRecord[]> {
    return this.readArray<AssetRecord>(this.assetsPath);
  }

  async paidRequests(): Promise<PaidRequestSummary[]> {
    return this.readArray<PaidRequestRecord>(this.requestsPath);
  }

  async paidRequest(id: string): Promise<PaidRequestSummary | undefined> {
    return (await this.paidRequests()).find((request) => request.id === id);
  }

  async usageForJob(jobId: string): Promise<
    | {
        at: string;
        model: string;
        costUsd: number | null;
        budgetUsd: number;
        unknownCost: boolean;
        operation: string;
      }
    | undefined
  > {
    const items = await this.readArray<{
      at: string;
      model: string;
      costUsd: number | null;
      budgetUsd: number;
      unknownCost: boolean;
      operation: string;
      jobId?: string;
    }>(this.usagePath);
    const found = items.find((item) => item.jobId === jobId);
    if (!found) return undefined;
    const { at, model, costUsd, budgetUsd, unknownCost, operation } = found;
    return { at, model, costUsd, budgetUsd, unknownCost, operation };
  }

  async saveJob(job: VideoJobRecord): Promise<void> {
    await this.serial(async () => {
      const items = await this.jobs();
      const index = items.findIndex((item) => item.id === job.id);
      if (index >= 0) items[index] = job;
      else items.push(job);
      await this.writeArray(this.jobsPath, items);
    });
  }

  async getJob(id: string): Promise<VideoJobRecord | undefined> {
    return (await this.jobs()).find((item) => item.id === id || item.remoteId === id);
  }

  async saveAsset(asset: AssetRecord): Promise<void> {
    await this.serial(async () => {
      const items = await this.assets();
      const index = asset.jobId
        ? items.findIndex(
            (item) =>
              item.jobId === asset.jobId && item.parameters?.output_index === asset.parameters?.output_index,
          )
        : -1;
      if (index >= 0) items[index] = asset;
      else items.push(asset);
      await this.writeArray(this.assetsPath, items);
    });
  }

  async recordUsage(entry: {
    at: string;
    model: string;
    costUsd: number;
    budgetUsd: number;
    unknownCost: boolean;
    operation: string;
    assetId?: string;
    jobId?: string;
  }): Promise<void> {
    await this.serial(async () => {
      const items = await this.readArray<typeof entry>(this.usagePath);
      const index = entry.jobId ? items.findIndex((item) => item.jobId === entry.jobId) : -1;
      if (index >= 0) items[index] = entry;
      else items.push(entry);
      await this.writeArray(this.usagePath, items);
    });
  }

  async reservePaidRequest(args: {
    id: string;
    operation: string;
    fingerprint: string;
    budgetUsd: number;
    unknownCost: boolean;
    maxTotalSpendUsd: number;
    allowUnknownCost: boolean;
  }): Promise<void> {
    await this.serial(async () => {
      const usage = await this.readArray<{ budgetUsd?: number; costUsd?: number; unknownCost?: boolean }>(
        this.usagePath,
      );
      const requests = await this.readArray<PaidRequestRecord>(this.requestsPath);
      const sameId = requests.find((request) => request.id === args.id);
      if (sameId) {
        if (sameId.fingerprint === args.fingerprint && sameId.state === 'pending') {
          // A worker may restart before post_started and refresh its catalog estimate.
          // Revalidate the reservation atomically instead of retaining a stale amount.
        } else {
          throw new AppError(
            'O identificador local já está associado a uma reserva diferente ou incerta.',
            'PAID_REQUEST_ID_CONFLICT',
          );
        }
      }
      const otherRequests = requests.filter((request) => request.id !== args.id);
      if (
        otherRequests.some(
          (request) =>
            request.fingerprint === args.fingerprint && ['pending', 'uncertain'].includes(request.state),
        )
      ) {
        throw new AppError(
          'Já existe uma tentativa idêntica em curso ou com resultado incerto. Consulte os jobs e a atividade OpenRouter; use reconcile_image_job apenas com evidência verificada e não remova a reserva manualmente.',
          'DUPLICATE_UNCERTAIN_REQUEST',
        );
      }
      if (usage.some((item) => item.unknownCost) || otherRequests.some((item) => item.unknownCost)) {
        throw new AppError(
          'O limite de gastos está suspenso porque existe uma operação de custo desconhecido por reconciliar.',
          'UNKNOWN_SPEND_REQUIRES_RECONCILIATION',
        );
      }
      if (args.unknownCost && !args.allowUnknownCost) {
        throw new AppError(
          'O custo não pode ser estimado e a política ALLOW_UNKNOWN_COST está desativada.',
          'COST_UNKNOWN',
        );
      }
      const committed =
        usage.reduce((sum, item) => sum + (item.budgetUsd ?? item.costUsd ?? 0), 0) +
        otherRequests.reduce((sum, item) => sum + item.budgetUsd, 0);
      if (
        committed >= args.maxTotalSpendUsd ||
        (!args.unknownCost && committed + args.budgetUsd > args.maxTotalSpendUsd)
      ) {
        throw new AppError(
          `A reserva excede o limite global de $${args.maxTotalSpendUsd.toFixed(2)}.`,
          'TOTAL_SPEND_LIMIT',
        );
      }
      const updatedRequest: PaidRequestRecord = {
        id: args.id,
        operation: args.operation,
        fingerprint: args.fingerprint,
        createdAt: sameId?.createdAt ?? new Date().toISOString(),
        state: 'pending',
        budgetUsd: args.budgetUsd,
        unknownCost: args.unknownCost,
      };
      const sameIndex = requests.findIndex((request) => request.id === args.id);
      if (sameIndex >= 0) requests[sameIndex] = updatedRequest;
      else requests.push(updatedRequest);
      await this.writeArray(this.requestsPath, requests);
    });
  }

  async releasePaidRequest(id: string): Promise<void> {
    await this.serial(async () => {
      const items = await this.readArray<PaidRequestRecord>(this.requestsPath);
      await this.writeArray(
        this.requestsPath,
        items.filter((item) => item.id !== id),
      );
    });
  }

  async completePaidRequest(
    id: string,
    entry: {
      at: string;
      model: string;
      costUsd: number | null;
      budgetUsd: number;
      unknownCost: boolean;
      operation: string;
      jobId?: string;
    },
  ): Promise<void> {
    await this.serial(async () => {
      const usage = await this.readArray<typeof entry & { requestId?: string }>(this.usagePath);
      const index = usage.findIndex(
        (item) => item.requestId === id || (entry.jobId && item.jobId === entry.jobId),
      );
      const value = { ...entry, requestId: id };
      if (index >= 0) usage[index] = value;
      else usage.push(value);
      await this.writeArray(this.usagePath, usage);
      const requests = await this.readArray<PaidRequestRecord>(this.requestsPath);
      await this.writeArray(
        this.requestsPath,
        requests.filter((item) => item.id !== id),
      );
    });
  }

  async markPaidRequestUncertain(
    id: string,
    args: { model: string; estimateUsd: number | null; operation: string; remoteId?: string },
  ): Promise<void> {
    await this.serial(async () => {
      const requests = await this.readArray<PaidRequestRecord>(this.requestsPath);
      const found = requests.find((item) => item.id === id);
      if (found) {
        found.state = 'uncertain';
        found.unknownCost = true;
        if (args.remoteId) found.remoteId = args.remoteId;
        await this.writeArray(this.requestsPath, requests);
      } else {
        throw new AppError(
          `A reserva local ${id} não existe; não é seguro classificar o pedido como incerto.`,
          'PAID_REQUEST_NOT_FOUND',
        );
      }
    });
  }

  async totalSpendUsd(): Promise<number> {
    const items = await this.readArray<{ costUsd?: number; budgetUsd?: number; unknownCost?: boolean }>(
      this.usagePath,
    );
    const requests = await this.readArray<PaidRequestRecord>(this.requestsPath);
    if (items.some((item) => item.unknownCost) || requests.some((item) => item.unknownCost))
      return Number.POSITIVE_INFINITY;
    return (
      items.reduce(
        (sum, item) =>
          sum +
          (typeof item.budgetUsd === 'number'
            ? item.budgetUsd
            : typeof item.costUsd === 'number'
              ? item.costUsd
              : 0),
        0,
      ) + requests.reduce((sum, item) => sum + item.budgetUsd, 0)
    );
  }
}
