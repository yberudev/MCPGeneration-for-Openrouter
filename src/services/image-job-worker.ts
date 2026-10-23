import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import * as lockfile from 'proper-lockfile';
import type { AppConfig } from '../config/env.js';
import type { OpenRouterClient } from '../providers/openrouter/client.js';
import { getTransportDiagnostic } from '../providers/openrouter/diagnostics.js';
import { AppError, sanitizeErrorMessage } from '../utils/errors.js';
import { AssetManager, detectImage, type ImageInfo } from './asset-manager.js';
import { CostGuard, type CostEstimate } from './cost-guard.js';
import type { MetadataStore } from './metadata-store.js';
import type { ImageJobQueue, ImageJob, PersistedImageOutput } from './image-job-queue.js';
import type { ModelRegistry } from './model-registry.js';

export interface ImageWorkerDependencies {
  config: AppConfig;
  client: OpenRouterClient;
  assets: AssetManager;
  costs: CostGuard;
  store: MetadataStore;
  queue: ImageJobQueue;
  registry?: ModelRegistry;
  pollIntervalMs?: number;
  wait?: (ms: number) => Promise<void>;
  logger?: (event: Record<string, unknown>) => void;
  assetsForJob?: (job: ImageJob, config: AppConfig, store: MetadataStore) => AssetManager;
  imageDetector?: (bytes: Buffer) => ImageInfo;
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
  const diagnostic = getTransportDiagnostic(error);
  if (diagnostic?.outcome === 'redirect_blocked')
    return `Redirecionamento HTTP bloqueado (${status ?? 'sem status'}); credenciais não foram reenviadas.`;
  if (status !== null && status >= 400 && status < 500) {
    if (!diagnostic) return `OpenRouter respondeu HTTP ${status}.`;
    const codes = diagnostic.error_codes.length ? ` (${diagnostic.error_codes.join(', ')})` : '';
    return `OpenRouter respondeu HTTP ${status}; falha ao ler os detalhes${codes} após ${diagnostic.duration_ms} ms.`;
  }
  const code = error instanceof AppError ? error.code : 'WORKER_ERROR';
  if (status !== null && status !== 200 && !diagnostic) return `OpenRouter respondeu HTTP ${status}.`;
  if (diagnostic) {
    const phases: Record<string, string> = {
      dns: 'resolução DNS',
      tcp_connect: 'ligação TCP',
      tls_handshake: 'negociação TLS',
      request_or_waiting_for_headers: 'envio ou espera dos cabeçalhos HTTP',
      response_body: 'leitura do corpo HTTP',
      response_parse: 'interpretação da resposta HTTP',
      redirect: 'redirecionamento HTTP',
    };
    const codes = diagnostic.error_codes.length ? ` (${diagnostic.error_codes.join(', ')})` : '';
    const outcome = diagnostic.timed_out ? 'timeout na' : 'falha na';
    const responseStatusText = status === null ? '' : `HTTP ${status}; `;
    return `${responseStatusText}${outcome} ${phases[diagnostic.phase]}${codes} após ${diagnostic.duration_ms} ms; POST incerto, sem retry automático.`;
  }
  const messages: Record<string, string> = {
    NETWORK_ERROR: 'Falha de rede ou timeout; o resultado do POST pode ser incerto.',
    INVALID_RESPONSE: 'Resposta do OpenRouter inválida; não houve retry.',
    IMAGE_RESPONSE_DATA_MISSING: 'A resposta HTTP 200 não continha o campo data esperado.',
    RESPONSE_READ_ERROR: 'A leitura da resposta falhou; não houve retry.',
    RESPONSE_TOO_LARGE: 'Resposta do OpenRouter excedeu o limite local; não houve retry.',
    RAW_RESPONSE_PERSIST_ERROR: 'A resposta HTTP 200 não pôde ser preservada localmente; a cobrança permanece incerta.',
    RAW_RESPONSE_STORAGE_LIMIT: 'A quota local de respostas preservadas foi atingida; a cobrança permanece incerta.',
    PRESERVED_RESPONSE_CORRUPT: 'A resposta HTTP preservada falhou na verificação de integridade.',
    IMAGE_DATA_MISSING: 'O resultado não continha data[].b64_json.',
    INVALID_BASE64: 'A resposta continha base64 inválido; a cobrança foi preservada e os bytes HTTP continuam disponíveis para recuperação local.',
    IMAGE_MIME_MISMATCH: 'O MIME declarado não corresponde ao formato da imagem recebida.',
    INVALID_IMAGE_FORMAT: 'Os bytes recebidos não correspondem a PNG, JPEG ou WebP reconhecido.',
    IMAGE_POST_UNCERTAIN: 'O estado do POST é incerto e não será repetido.',
    IMAGE_OUTPUT_COUNT_MISMATCH: 'O número de imagens devolvidas foi inferior ao esperado.',
    IMAGE_RESPONSE_EMPTY: 'A resposta não continha uma imagem entregável.',
    IMAGE_TOO_LARGE: 'A imagem excedeu o limite local.',
    IMAGE_INTEGRITY_CHECK_FAILED: 'A verificação de integridade do ficheiro falhou.',
  };
  return messages[code] ?? `${code}: erro técnico local sem detalhes sensíveis.`;
}

function toOutputs(
  job: ImageJob,
  response: unknown,
  maxBytes: number,
  imageDetector: (bytes: Buffer) => ImageInfo = detectImage,
): PersistedImageOutput[] {
  const data = (response as { data?: Array<{ b64_json?: unknown }> })?.data;
  if (data === undefined)
    throw new AppError('A resposta não contém o campo data esperado.', 'IMAGE_RESPONSE_DATA_MISSING');
  if (!Array.isArray(data))
    throw new AppError('O campo data da resposta não é uma lista.', 'INVALID_RESPONSE');
  if (!data.length)
    throw new AppError('A resposta não contém imagens geradas.', 'IMAGE_RESPONSE_EMPTY');
  const outputs: PersistedImageOutput[] = [];
  for (let index = 0; index < data.length; index += 1) {
    const item = data[index] as { b64_json?: unknown; media_type?: unknown } | undefined;
    const value = item?.b64_json;
    if (typeof value !== 'string')
      throw new AppError('A resposta não contém data[].b64_json.', 'IMAGE_DATA_MISSING');
    if (Math.ceil(value.length * 0.75) > maxBytes)
      throw new AppError('A resposta de imagem excede o limite local.', 'IMAGE_TOO_LARGE');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
      throw new AppError('A resposta contém base64 inválido.', 'INVALID_BASE64');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value)
      throw new AppError('A resposta contém base64 não canónico.', 'INVALID_BASE64');
    if (!bytes.length)
      throw new AppError('O campo b64_json não contém bytes de imagem.', 'IMAGE_DATA_MISSING');
    if (bytes.length > maxBytes)
      throw new AppError('A resposta de imagem está vazia ou excede o limite.', 'IMAGE_TOO_LARGE');
    const image = imageDetector(bytes);
    if (item?.media_type !== undefined && item.media_type !== image.mimeType)
      throw new AppError('O MIME declarado não corresponde à assinatura detetada.', 'IMAGE_MIME_MISMATCH');
    outputs.push({
      index,
      mimeType: image.mimeType,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return outputs;
}

function safeValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function safeResponseMetadata(value: unknown): Record<string, unknown> {
  const object = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
  const allowedTopFields = ['data', 'usage', 'model', 'created', 'id', 'error'];
  const metadata: Record<string, unknown> = {
    jsonValid: object !== undefined,
    topLevelFields: object ? Object.keys(object).filter((key) => allowedTopFields.includes(key)).sort() : [],
  };
  if (!object) return metadata;
  const data = object.data;
  metadata.dataState = data === undefined ? 'missing' : Array.isArray(data) ? 'array' : safeValueType(data);
  if (Array.isArray(data)) {
    metadata.dataCount = data.length;
    metadata.items = data.slice(0, 20).map((item) => {
      const row = item && typeof item === 'object' && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : undefined;
      if (!row) return { itemType: safeValueType(item) };
      const fields: Record<string, string> = {};
      for (const key of ['b64_json', 'media_type', 'revised_prompt', 'url', 'mime_type'])
        if (Object.hasOwn(row, key)) fields[key] = safeValueType(row[key]);
      const mime = typeof row.media_type === 'string' ? row.media_type.toLowerCase() : undefined;
      return {
        fields,
        ...(typeof row.b64_json === 'string' ? { b64JsonLength: row.b64_json.length } : {}),
        ...(mime && ['image/png', 'image/jpeg', 'image/webp'].includes(mime)
          ? { mediaType: mime }
          : mime
            ? { mediaType: 'other' }
            : {}),
      };
    });
    if (data.length > 20) metadata.itemsTruncated = true;
  }
  const usage = object.usage && typeof object.usage === 'object' && !Array.isArray(object.usage)
    ? (object.usage as Record<string, unknown>)
    : undefined;
  const cost = usage?.cost;
  metadata.usageState = object.usage === undefined ? 'missing' : safeValueType(object.usage);
  metadata.usageCostState = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
    ? 'available'
    : cost === undefined
      ? 'missing'
      : 'invalid';
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) metadata.usageCostUsd = cost;
  return metadata;
}

function inspectRawResponse(body: Buffer): {
  actualCostUsd: number | null;
  safeMetadata: Record<string, unknown>;
} {
  try {
    const value: unknown = JSON.parse(body.toString('utf8'));
    const safeMetadata = safeResponseMetadata(value);
    const usage = value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).usage
      : undefined;
    const cost = usage && typeof usage === 'object' && !Array.isArray(usage)
      ? (usage as Record<string, unknown>).cost
      : undefined;
    return {
      actualCostUsd:
        typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
      safeMetadata,
    };
  } catch {
    return {
      actualCostUsd: null,
      safeMetadata: { jsonValid: false, parseState: 'invalid_json', topLevelFields: [] },
    };
  }
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
      const network = getTransportDiagnostic(error);
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
        current?.phase === 'response_preserved' ||
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
        ...(network
          ? {
              request_duration_ms: network.duration_ms,
              network_phase: network.phase,
              network_layer: network.transport_layer,
              network_outcome: network.outcome,
              network_timed_out: network.timed_out,
              ...(network.timeout_kind ? { timeout_kind: network.timeout_kind } : {}),
              error_codes: network.error_codes,
              error_names: network.error_names,
            }
          : {}),
      });
    }
    return true;
  }

  private estimate(job: ImageJob): CostEstimate {
    if (job.payload.estimateDetails) return job.payload.estimateDetails;
    return {
      status: job.payload.estimateUsd === null ? 'unknown' : 'estimated',
      kind: job.payload.estimateUsd === null ? 'unknown' : 'grounded_estimate',
      estimateUsd: job.payload.estimateUsd,
      source: job.payload.estimateSource,
      sourceDate: job.createdAt,
      confidence: job.payload.estimateUsd === null ? 'none' : 'medium',
      parameters: { model: job.model, operation: job.operation },
      assumptions: [],
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

  private async liveEstimate(job: ImageJob): Promise<CostEstimate> {
    const modelId = job.model;
    const body = job.payload.requestBodies[0];
    const operation =
      job.operation === 'edit_image' ? 'edit' : job.operation === 'generate_variations' ? 'variation' : 'generate';
    const options = {
      resolution: body?.resolution,
      aspectRatio: body?.aspect_ratio,
      referenceCount: body?.input_references?.length ?? 0,
    };
    if (!this.deps.registry) return this.estimate(job);
    let model;
    try {
      model = await this.deps.registry.image(modelId, true);
    } catch {
      return {
        status: 'unknown',
        kind: 'unknown',
        estimateUsd: null,
        source: 'OpenRouter live image catalog',
        sourceDate: new Date().toISOString(),
        confidence: 'none',
        parameters: { model: modelId, operation, count: job.payload.expectedOutputCount, ...options },
        assumptions: [],
        limitations: ['Não foi possível confirmar o modelo e os preços atuais antes da reserva e do POST.'],
      };
    }
    let pricing: unknown;
    let modelDetails;
    try {
      pricing = await this.deps.registry.imagePricing(model);
    } catch {
      /* CostGuard returns unknown if the live endpoint pricing is unavailable. */
    }
    if (modelId === 'google/gemini-3.1-flash-lite-image') {
      try {
        modelDetails = await this.deps.registry.modelDetails(modelId, true);
      } catch {
        /* CostGuard returns unknown if a required token price/limit is unavailable. */
      }
    }
    return this.deps.costs.imageEstimate(
      model,
      pricing,
      job.payload.expectedOutputCount,
      operation,
      { ...options, modelDetails },
    );
  }

  private async accountInterpretationFailure(
    job: ImageJob,
    callIndex: number,
    error: unknown,
    httpStatus: number,
  ): Promise<void> {
    const preserved = this.deps.queue.preservedResponse(job.id, callIndex);
    if (!preserved)
      throw new AppError('A resposta não está preservada para recuperação local.', 'PRESERVED_RESPONSE_MISSING');
    const inspected = inspectRawResponse(preserved.body);
    const errorCode = error instanceof AppError ? error.code : 'WORKER_ERROR';
    this.deps.queue.markResponseInterpretationFailed(
      job.id,
      callIndex,
      inspected.actualCostUsd,
      httpStatus,
      inspected.safeMetadata,
      errorCode,
    );
    const confirmed = this.deps.queue.confirmedCalls(job.id);
    const actualCost = confirmed.allCostsKnown ? confirmed.totalCostUsd : null;
    const financialState = actualCost === null ? 'cost_unknown' : 'accounted';
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
    this.deps.queue.setPhase(job.id, 'cost_accounted', 'response_persisted', financialState);
    this.log({
      event: 'response_interpretation_failed',
      job_id: job.id,
      request_id: job.requestId,
      model: job.model,
      http_status: httpStatus,
      call_index: callIndex,
      error_code: errorCode,
      response_bytes: preserved.sizeBytes,
      response_sha256: preserved.sha256,
      actual_cost_usd: actualCost,
      cost_known: actualCost !== null,
      safe_response_metadata: inspected.safeMetadata,
      post_retried: false,
    });
  }

  private async process(initialJob: ImageJob): Promise<void> {
    let job = initialJob;
    await this.assetsForJob(job).outputDirectory(job.payload.resolvedOutputDir, 'image');
    const alreadyReceived = job.payload.requestBodies.some((_, index) => {
      const state = this.deps.queue.callState(job.id, index);
      return state === 'response_received' || state === 'response_preserved';
    });
    if (!alreadyReceived) {
      const estimate = await this.liveEstimate(job);
      this.deps.queue.updateEstimate(job.id, estimate);
      job = this.deps.queue.get(job.id)!;
    }
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
      let response: Awaited<ReturnType<OpenRouterClient['parseImageGenerationResponseBody']>>;
      let httpStatus: number;
      let receivedHttpStatus: number | null = null;
      try {
        if (callState === 'response_preserved') {
          const preserved = this.deps.queue.preservedResponse(job.id, callIndex);
          if (!preserved)
            throw new AppError('A resposta preservada não está disponível.', 'PRESERVED_RESPONSE_MISSING');
          receivedHttpStatus = preserved.httpStatus;
          response = this.deps.client.parseImageGenerationResponseBody(preserved.body);
          httpStatus = preserved.httpStatus;
          this.log({
            event: 'local_response_recovery_started',
            job_id: job.id,
            request_id: job.requestId,
            model: job.model,
            http_status: preserved.httpStatus,
            call_index: callIndex,
            response_bytes: preserved.sizeBytes,
            post_sent: false,
          });
        } else {
          this.deps.queue.markCallPostStarted(job.id, callIndex);
          this.log({
            event: 'http_request_started',
            job_id: job.id,
            request_id: job.requestId,
            model: job.model,
            call_index: callIndex,
            timeout_ms: this.deps.config.httpTimeoutMs,
          });
          const result = await this.deps.client.generateImageWithStatus(
            job.payload.requestBodies[callIndex]!,
            (status, requestDurationMs) => {
              receivedHttpStatus = status;
              this.deps.queue.recordHttpStatus(job.id, status);
              this.log({
                event: 'http_response_received',
                job_id: job.id,
                request_id: job.requestId,
                model: job.model,
                http_status: status,
                request_duration_ms: requestDurationMs,
                phase: 'response_headers',
                call_index: callIndex,
              });
            },
            (raw) => {
              const saved = this.deps.queue.saveRawResponse(
                job.id,
                callIndex,
                raw,
                this.deps.config.maxRawResponseStorageBytes,
              );
              this.log({
                event: 'raw_http_response_preserved',
                job_id: job.id,
                request_id: job.requestId,
                model: job.model,
                http_status: raw.status,
                call_index: callIndex,
                size_bytes: saved.sizeBytes,
                sha256: saved.sha256,
              });
            },
          );
          response = result.response;
          httpStatus = result.status;
        }
      } catch (error) {
        const status = receivedHttpStatus ?? this.deps.queue.httpStatus(job.id) ?? responseStatus(error);
        if (status === 200 && this.deps.queue.hasPreservedResponse(job.id, callIndex)) {
          await this.accountInterpretationFailure(job, callIndex, error, status);
        }
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
        outputs = toOutputs(job, response, this.deps.config.maxImageBytes, this.deps.imageDetector);
      } catch (error) {
        await this.accountInterpretationFailure(job, callIndex, error, httpStatus);
        throw error;
      }
      const cost = typeof response.usage?.cost === 'number' ? response.usage.cost : null;
      this.deps.queue.saveResponse(
        job.id,
        callIndex,
        outputs,
        cost,
        httpStatus,
        safeResponseMetadata(response),
      );
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
