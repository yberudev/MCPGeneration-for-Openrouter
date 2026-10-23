import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import * as lockfile from 'proper-lockfile';
import type { AppConfig } from '../config/env.js';
import type { OpenRouterClient } from '../providers/openrouter/client.js';
import { AppError, sanitizeErrorMessage } from '../utils/errors.js';
import { AssetManager, detectImage } from './asset-manager.js';
import { CostGuard, type CostEstimate } from './cost-guard.js';
import type { MetadataStore } from './metadata-store.js';
import type { ImageJobQueue, ImageJob, PersistedImageOutput } from './image-job-queue.js';

export interface ImageWorkerDependencies {
  config: AppConfig;
  client: OpenRouterClient;
  assets: AssetManager;
  costs: CostGuard;
  store: MetadataStore;
  queue: ImageJobQueue;
  pollIntervalMs?: number;
  wait?: (ms: number) => Promise<void>;
  logger?: (event: Record<string, unknown>) => void;
  assetsForJob?: (job: ImageJob, config: AppConfig, store: MetadataStore) => AssetManager;
}

function responseStatus(error: unknown): number | null {
  const code = error instanceof AppError ? error.code : '';
  const match = /^OPENROUTER_HTTP_(\d{3})$/.exec(code);
  return match ? Number(match[1]) : null;
}

function httpErrorIsDefinitive(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500;
}

function technicalError(error: unknown, status: number | null): string {
  if (status !== null) return `OpenRouter respondeu HTTP ${status}.`;
  const code = error instanceof AppError ? error.code : 'WORKER_ERROR';
  const messages: Record<string, string> = {
    NETWORK_ERROR: 'Falha de rede ou timeout; o resultado do POST pode ser incerto.',
    INVALID_RESPONSE: 'Resposta do OpenRouter inválida; não houve retry.',
    RESPONSE_TOO_LARGE: 'Resposta do OpenRouter excedeu o limite local; não houve retry.',
    IMAGE_POST_UNCERTAIN: 'O estado do POST é incerto e não será repetido.',
    IMAGE_OUTPUT_COUNT_MISMATCH: 'O número de imagens devolvidas foi inferior ao esperado.',
    IMAGE_RESPONSE_EMPTY: 'A resposta não continha uma imagem entregável.',
    IMAGE_TOO_LARGE: 'A imagem excedeu o limite local.',
    IMAGE_INTEGRITY_CHECK_FAILED: 'A verificação de integridade do ficheiro falhou.',
  };
  return messages[code] ?? `${code}: erro técnico local sem detalhes sensíveis.`;
}

function toOutputs(job: ImageJob, response: unknown, maxBytes: number): PersistedImageOutput[] {
  const data = (response as { data?: Array<{ b64_json?: unknown }> })?.data;
  if (!Array.isArray(data) || !data.length)
    throw new AppError('A resposta não contém imagens geradas.', 'IMAGE_RESPONSE_EMPTY');
  const outputs: PersistedImageOutput[] = [];
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index]?.b64_json;
    if (typeof value !== 'string' || Math.ceil(value.length * 0.75) > maxBytes)
      throw new AppError('A resposta de imagem é inválida ou demasiado grande.', 'INVALID_IMAGE_DATA');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
      throw new AppError('A resposta contém base64 inválido.', 'INVALID_IMAGE_DATA');
    const bytes = Buffer.from(value, 'base64');
    if (!bytes.length || bytes.length > maxBytes)
      throw new AppError('A resposta de imagem está vazia ou excede o limite.', 'IMAGE_TOO_LARGE');
    const image = detectImage(bytes);
    outputs.push({
      index,
      mimeType: image.mimeType,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return outputs;
}

export class ImageJobWorker {
  private stopping = false;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly deps: ImageWorkerDependencies) {
    this.wait = deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  requestStop(): void {
    this.stopping = true;
  }

  async run(): Promise<void> {
    const release = await lockfile.lock(this.deps.queue.databasePath, {
      stale: 30_000,
      update: 10_000,
      retries: 0,
    });
    try {
      await this.recover();
      this.log({ event: 'worker_started' });
      while (!this.stopping) {
        const processed = await this.runOne();
        if (!processed) await this.wait(this.deps.pollIntervalMs ?? 750);
      }
      this.log({ event: 'worker_stopped' });
    } finally {
      await release();
    }
  }

  async recover(): Promise<void> {
    const uncertainIds = this.deps.queue.recoverAfterRestart();
    for (const id of uncertainIds) {
      const job = this.deps.queue.get(id);
      if (!job) continue;
      await this.deps.store.markPaidRequestUncertain(job.requestId, {
        model: job.model,
        estimateUsd: job.payload.estimateUsd,
        operation: `${job.operation}_uncertain`,
      });
    }
  }

  async runOne(): Promise<boolean> {
    const job = this.deps.queue.claimNext();
    if (!job) return false;
    const started = performance.now();
    this.log({ event: 'job_claimed', job_id: job.id, request_id: job.requestId, model: job.model });
    try {
      if (
        (job.phase === 'files_persisted' || job.phase === 'cost_accounted') &&
        this.deps.queue.allCallsReceivedForJob(job)
      ) {
        await this.deliver(job);
      } else {
        await this.process(job);
      }
      this.log({
        event: 'job_finished',
        job_id: job.id,
        request_id: job.requestId,
        model: job.model,
        duration_ms: Math.round(performance.now() - started),
        phase: this.deps.queue.get(job.id)?.phase,
        http_status: this.deps.queue.httpStatus(job.id),
        cost_usd: this.deps.queue.get(job.id)?.actualCostUsd,
      });
    } catch (error) {
      const current = this.deps.queue.get(job.id);
      const status = this.deps.queue.httpStatus(job.id) ?? responseStatus(error);
      const code = error instanceof AppError ? error.code : 'WORKER_ERROR';
      const message = technicalError(error, status);
      if (current?.phase === 'post_started') {
        if (httpErrorIsDefinitive(status)) {
          await this.deps.store.releasePaidRequest(job.requestId).catch(() => undefined);
          this.deps.queue.fail(job.id, code, message, status);
        } else {
          await this.deps.store
            .markPaidRequestUncertain(job.requestId, {
              model: job.model,
              estimateUsd: job.payload.estimateUsd,
              operation: `${job.operation}_uncertain`,
            })
            .catch(() => undefined);
          this.deps.queue.uncertain(job.id, code, message, status);
        }
      } else if (
        current?.phase === 'result_parsed' ||
        current?.phase === 'files_persisted' ||
        current?.phase === 'files_persisting' ||
        current?.phase === 'cost_accounted'
      ) {
        this.deps.queue.deliveryFailure(job.id, code, message);
      } else {
        await this.deps.store.releasePaidRequest(job.requestId).catch(() => undefined);
        this.deps.queue.fail(job.id, code, message, status);
      }
      this.log({
        event: 'job_error',
        job_id: job.id,
        request_id: job.requestId,
        model: job.model,
        duration_ms: Math.round(performance.now() - started),
        phase: current?.phase,
        http_status: status,
        error_code: code,
        error: message,
      });
    }
    return true;
  }

  private estimate(job: ImageJob): CostEstimate {
    return {
      status: job.payload.estimateUsd === null ? 'unknown' : 'estimated',
      estimateUsd: job.payload.estimateUsd,
      source: job.payload.estimateSource,
      confidence: job.payload.estimateUsd === null ? 'none' : 'medium',
      parameters: { model: job.model, operation: job.operation },
      limitations: [],
    };
  }

  private costsForJob(job: ImageJob): CostGuard {
    return new CostGuard(
      {
        ...this.deps.config,
        maxCostPerRequestUsd: Math.min(
          this.deps.config.maxCostPerRequestUsd,
          job.payload.maxCostPerRequestUsd,
        ),
        maxTotalSpendUsd: Math.min(this.deps.config.maxTotalSpendUsd, job.payload.maxTotalSpendUsd),
        allowUnknownCost: this.deps.config.allowUnknownCost && job.payload.allowUnknownCost,
      },
      this.deps.store,
    );
  }

  private async process(job: ImageJob): Promise<void> {
    await this.assetsForJob(job).outputDirectory(job.payload.resolvedOutputDir, 'image');
    const costs = this.costsForJob(job);
    costs.validate(this.estimate(job), {
      allowPaid: true,
      maxCostUsd: job.payload.maxCostUsd,
    });
    const alreadyAccounted = await this.deps.store.usageForJob(job.id);
    if (!alreadyAccounted) {
      await costs.authorize(
        this.estimate(job),
        { allowPaid: true, maxCostUsd: job.payload.maxCostUsd },
        job.operation,
        job.fingerprint,
        job.requestId,
      );
      this.deps.queue.setPhase(job.id, 'budget_reserved', undefined, 'reserved');
    }

    for (let callIndex = 0; callIndex < job.payload.requestBodies.length; callIndex += 1) {
      const callState = this.deps.queue.callState(job.id, callIndex);
      if (callState === 'response_received') continue;
      if (callState === 'post_started')
        throw new AppError('O estado do POST é incerto; o worker não o vai repetir.', 'IMAGE_POST_UNCERTAIN');
      this.deps.queue.markCallPostStarted(job.id, callIndex);
      let response;
      let httpStatus: number;
      let receivedHttpStatus: number | null = null;
      try {
        const result = await this.deps.client.generateImageWithStatus(
          job.payload.requestBodies[callIndex]!,
          (status) => {
            receivedHttpStatus = status;
            this.deps.queue.recordHttpStatus(job.id, status);
            this.log({
              event: 'http_response_received',
              job_id: job.id,
              request_id: job.requestId,
              model: job.model,
              http_status: status,
              call_index: callIndex,
            });
          },
        );
        response = result.response;
        httpStatus = result.status;
      } catch (error) {
        const status = receivedHttpStatus ?? this.deps.queue.httpStatus(job.id) ?? responseStatus(error);
        const confirmed = this.deps.queue.confirmedCalls(job.id);
        if (httpErrorIsDefinitive(status) && confirmed.count > 0) {
          const actualCost = confirmed.allCostsKnown ? confirmed.totalCostUsd : null;
          const financialState = actualCost === null ? 'cost_unknown' : 'accounted';
          await this.deps.store.completePaidRequest(job.requestId, {
            at: new Date().toISOString(),
            model: job.model,
            costUsd: actualCost,
            budgetUsd: actualCost ?? job.payload.estimateUsd ?? 0,
            unknownCost: actualCost === null,
            operation: job.operation,
            jobId: job.id,
          });
          this.deps.queue.setActualCost(job.id, actualCost);
          this.deps.queue.setPhase(job.id, 'cost_accounted', 'response_persisted', financialState);
          await this.deliver(this.deps.queue.get(job.id)!);
          this.deps.queue.partialFailure(
            job.id,
            this.deps.queue.get(job.id)!.files,
            error instanceof AppError ? error.code : 'OPENROUTER_REJECTED',
            technicalError(error, status),
            status!,
            financialState,
          );
          return;
        }
        throw error;
      }
      let outputs: PersistedImageOutput[];
      try {
        outputs = toOutputs(job, response, this.deps.config.maxImageBytes);
      } catch (error) {
        const cost = typeof response.usage?.cost === 'number' ? response.usage.cost : null;
        this.deps.queue.saveResponse(job.id, callIndex, [], cost, httpStatus);
        const confirmed = this.deps.queue.confirmedCalls(job.id);
        const actualCost = confirmed.allCostsKnown ? confirmed.totalCostUsd : null;
        this.deps.queue.setActualCost(job.id, actualCost);
        await this.deps.store.completePaidRequest(job.requestId, {
          at: new Date().toISOString(),
          model: job.model,
          costUsd: actualCost,
          budgetUsd: actualCost ?? job.payload.estimateUsd ?? 0,
          unknownCost: actualCost === null,
          operation: job.operation,
          jobId: job.id,
        });
        this.deps.queue.setPhase(
          job.id,
          'cost_accounted',
          'response_persisted',
          actualCost === null ? 'cost_unknown' : 'accounted',
        );
        throw error;
      }
      const cost = typeof response.usage?.cost === 'number' ? response.usage.cost : null;
      this.deps.queue.saveResponse(job.id, callIndex, outputs, cost, httpStatus);
      this.log({
        event: 'result_parsed_and_durably_stored',
        job_id: job.id,
        request_id: job.requestId,
        model: job.model,
        http_status: httpStatus,
        call_index: callIndex,
        output_count: outputs.length,
      });
    }

    const fresh = this.deps.queue.get(job.id)!;
    const outputs = this.deps.queue.outputs(job.id);
    if (!outputs.length)
      throw new AppError('A resposta não contém imagens entregáveis.', 'IMAGE_RESPONSE_EMPTY');
    const allCallsCostKnown = fresh.actualCostUsd !== null;
    await this.deps.store.completePaidRequest(job.requestId, {
      at: new Date().toISOString(),
      model: job.model,
      costUsd: fresh.actualCostUsd,
      budgetUsd: fresh.actualCostUsd ?? job.payload.estimateUsd ?? 0,
      unknownCost: !allCallsCostKnown,
      operation: job.operation,
      jobId: job.id,
    });
    this.deps.queue.setPhase(
      job.id,
      'cost_accounted',
      'response_persisted',
      allCallsCostKnown ? 'accounted' : 'cost_unknown',
    );
    this.log({
      event: 'cost_accounted',
      job_id: job.id,
      request_id: job.requestId,
      model: job.model,
      http_status: this.deps.queue.httpStatus(job.id),
      cost_usd: fresh.actualCostUsd,
      cost_known: allCallsCostKnown,
    });
    if (outputs.length < job.payload.expectedOutputCount)
      throw new AppError(
        `O fornecedor devolveu ${outputs.length} de ${job.payload.expectedOutputCount} imagem(ns) esperada(s).`,
        'IMAGE_OUTPUT_COUNT_MISMATCH',
      );
    await this.deliver(this.deps.queue.get(job.id)!);
  }

  private async deliver(job: ImageJob): Promise<void> {
    const outputs = this.deps.queue.outputs(job.id);
    if (!outputs.length)
      throw new AppError('O job não tem saídas duráveis para entregar.', 'IMAGE_OUTPUT_MISSING');
    this.deps.queue.setPhase(job.id, 'files_persisting');
    const files: string[] = [];
    for (let index = 0; index < outputs.length; index += 1) {
      const output = outputs[index]!;
      const extension =
        output.mimeType === 'image/jpeg' ? '.jpg' : output.mimeType === 'image/webp' ? '.webp' : '.png';
      const baseName =
        job.operation === 'generate_variations'
          ? `variation-${job.id}`
          : `${job.payload.filename?.replace(/\.[^.]+$/, '') ?? 'image'}-${job.id}`;
      const generatedName = `${baseName}-${String(index + 1).padStart(2, '0')}${extension}`;
      const asset = await this.assetsForJob(job).saveImage({
        bytes: output.bytes,
        filename: generatedName,
        outputDir: job.payload.resolvedOutputDir,
        model: job.model,
        prompt: job.payload.prompt,
        costUsd: index === 0 ? job.actualCostUsd : null,
        generationId: job.id,
        jobId: job.id,
        ...(job.payload.sourcePath ? { relatedAssetPath: job.payload.sourcePath } : {}),
        ...(job.payload.relatedAssetId ? { relatedAssetId: job.payload.relatedAssetId } : {}),
        parameters: { output_index: index, estimate_usd: job.estimateUsd },
      });
      const written = await readFile(asset.path);
      if (
        written.length !== output.bytes.length ||
        createHash('sha256').update(written).digest('hex') !== output.sha256
      )
        throw new AppError(
          'O ficheiro de imagem persistido não corresponde à resposta recebida.',
          'IMAGE_INTEGRITY_CHECK_FAILED',
        );
      files.push(asset.path);
      this.log({
        event: 'file_persisted_and_verified',
        job_id: job.id,
        request_id: job.requestId,
        model: job.model,
        output_index: index,
        size_bytes: output.bytes.length,
        sha256: output.sha256,
      });
    }
    this.deps.queue.setPhase(job.id, 'files_persisted', 'files_persisted');
    this.deps.queue.finish(job.id, files);
  }

  private assetsForJob(job: ImageJob): AssetManager {
    if (this.deps.assetsForJob) return this.deps.assetsForJob(job, this.deps.config, this.deps.store);
    const jobConfig: AppConfig = {
      ...this.deps.config,
      projectRoot: job.payload.outputRoot,
      allowedRoots: [...new Set([...this.deps.config.allowedRoots, job.payload.outputRoot])],
    };
    return new AssetManager(jobConfig, this.deps.store);
  }

  private log(event: Record<string, unknown>): void {
    const safe = Object.fromEntries(
      Object.entries(event).map(([key, value]) => [
        key,
        typeof value === 'string' ? sanitizeErrorMessage(value) : value,
      ]),
    );
    (this.deps.logger ?? ((entry) => process.stderr.write(`${JSON.stringify(entry)}\n`)))(safe);
  }
}
