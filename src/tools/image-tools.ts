import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AppConfig } from '../config/env.js';
import type { OpenRouterClient } from '../providers/openrouter/client.js';
import type { ImageModel, OpenRouterImageRequest } from '../types/openrouter.js';
import { AppError } from '../utils/errors.js';
import type { AssetManager } from '../services/asset-manager.js';
import type { CostGuard } from '../services/cost-guard.js';
import type { MetadataStore } from '../services/metadata-store.js';
import type { ImageJobQueue, ImageJobPayload, ImageJobStatus } from '../services/image-job-queue.js';
import type { ModelRegistry } from '../services/model-registry.js';
import { safely } from './result.js';

const imageBase = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  model: z.string().trim().min(1).optional(),
  aspect_ratio: z.string().trim().min(1).optional(),
  resolution: z.string().trim().min(1).optional(),
  size: z.string().trim().min(1).optional(),
  output_dir: z.string().trim().min(1).optional(),
  filename: z.string().trim().min(1).optional(),
  allow_paid: z.boolean().default(false),
  max_cost_usd: z.number().positive().optional(),
  dry_run: z.boolean().default(false),
});

interface ImageDeps {
  config: AppConfig;
  client: OpenRouterClient;
  registry: ModelRegistry;
  assets: AssetManager;
  costs: CostGuard;
  store: MetadataStore;
  imageQueue: ImageJobQueue;
}

function capability(model: ImageModel, key: string): unknown {
  return model.supported_parameters?.[key];
}

function validateImageModel(
  model: ImageModel,
  args: { aspect_ratio?: string; resolution?: string; size?: string; n?: number; references?: number },
): void {
  if (!model.architecture?.output_modalities?.includes('image'))
    throw new AppError(
      `O modelo ${model.id} não declara saída de imagem no catálogo.`,
      'MODEL_CAPABILITY_MISMATCH',
    );
  const supported = model.supported_parameters ?? {};
  for (const [key, value] of Object.entries({
    aspect_ratio: args.aspect_ratio,
    resolution: args.resolution,
    size: args.size,
  })) {
    if (value === undefined) continue;
    const rule = supported[key];
    if (!rule)
      throw new AppError(
        `O modelo ${model.id} não anuncia suporte ao parâmetro ${key}.`,
        'UNSUPPORTED_PARAMETER',
      );
    if (
      typeof rule === 'object' &&
      rule !== null &&
      'values' in rule &&
      Array.isArray((rule as { values?: unknown }).values) &&
      !(rule as { values: unknown[] }).values.includes(value)
    )
      throw new AppError(
        `${key}=${value} não é suportado por ${model.id}. Valores publicados: ${(rule as { values: unknown[] }).values.join(', ')}.`,
        'UNSUPPORTED_PARAMETER_VALUE',
      );
    if (
      key === 'size' &&
      typeof rule === 'object' &&
      rule !== null &&
      'type' in rule &&
      (rule as { type: unknown }).type === 'boolean'
    )
      throw new AppError(
        `O catálogo não publica dimensões concretas para ${model.id}.`,
        'UNVERIFIED_PARAMETER',
      );
  }
  if (args.n !== undefined && args.n > 1) {
    const rule = capability(model, 'n');
    const max =
      typeof rule === 'object' && rule !== null && 'max' in rule ? Number((rule as { max: unknown }).max) : 1;
    if (!Number.isFinite(max) || args.n > max)
      throw new AppError(
        `O modelo ${model.id} permite no máximo ${Number.isFinite(max) ? max : 1} resultado(s) por chamada.`,
        'UNSUPPORTED_PARAMETER_VALUE',
      );
  }
  if (args.references) {
    const rule = capability(model, 'input_references');
    const max =
      typeof rule === 'object' && rule !== null && 'max' in rule ? Number((rule as { max: unknown }).max) : 0;
    const min =
      typeof rule === 'object' && rule !== null && 'min' in rule ? Number((rule as { min: unknown }).min) : 0;
    if (!rule || args.references > max || args.references < min)
      throw new AppError(
        `O modelo ${model.id} não aceita ${args.references} imagem(ns) de referência.`,
        'IMAGE_REFERENCE_UNSUPPORTED',
      );
  }
}

async function estimateImage(
  deps: ImageDeps,
  model: ImageModel,
  count: number,
  operation: 'generate' | 'edit' | 'variation',
  options: { resolution?: string; aspectRatio?: string; referenceCount?: number } = {},
) {
  let pricing: unknown;
  let modelDetails;
  try {
    pricing = await deps.registry.imagePricing(model);
  } catch {
    /* CostGuard reports unknown. */
  }
  if (model.id === 'google/gemini-3.1-flash-lite-image') {
    try {
      modelDetails = await deps.registry.modelDetails(model.id);
    } catch {
      /* CostGuard reports unknown if a live upper-bound input is unavailable. */
    }
  }
  return deps.costs.imageEstimate(model, pricing, count, operation, { ...options, modelDetails });
}

function requestBody(
  model: string,
  prompt: string,
  options: { aspect_ratio?: string; resolution?: string; size?: string; n?: number; reference?: string },
): OpenRouterImageRequest {
  return {
    model,
    prompt,
    ...(options.aspect_ratio ? { aspect_ratio: options.aspect_ratio } : {}),
    ...(options.resolution ? { resolution: options.resolution } : {}),
    ...(options.size ? { size: options.size } : {}),
    ...(options.n !== undefined ? { n: options.n } : {}),
    ...(options.reference
      ? { input_references: [{ type: 'image_url', image_url: { url: options.reference } }] }
      : {}),
  };
}

function redactedBody(body: OpenRouterImageRequest): OpenRouterImageRequest {
  if (!body.input_references) return body;
  const references = body.input_references.map((reference) => ({
    ...reference,
    image_url: {
      url: reference.image_url.url.replace(/^data:([^;]+);base64,.+$/, '[base64 omitido; data URL $1]'),
    },
  }));
  return { ...body, input_references: references };
}

function publicJob(job: ReturnType<ImageJobQueue['get']>) {
  if (!job) return undefined;
  return {
    job_id: job.id,
    request_id: job.requestId,
    status: job.status,
    phase: job.phase,
    delivery_state: job.deliveryState,
    financial_state: job.financialState,
    model: job.model,
    operation: job.operation,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    estimate_usd: job.estimateUsd,
    estimate: job.payload.estimateDetails,
    cost_usd: job.actualCostUsd,
    http_status: job.httpStatus,
    error_code: job.errorCode,
    error: job.errorMessage,
    files: job.files,
  };
}

function outputJobResult(job: ReturnType<ImageJobQueue['get']>, duplicate: boolean) {
  return {
    success: true,
    accepted: true,
    duplicate,
    job_id: job!.id,
    status: job!.status,
    model: job!.model,
    estimate_usd: job!.estimateUsd,
    estimate: job!.payload.estimateDetails,
    cost_reservation: 'worker reserves the budget atomically before the paid POST',
    message:
      'Job persistido localmente. O worker independente executará a geração; consulte get_image_job_status.',
  };
}

async function enqueue(
  deps: ImageDeps,
  args: { allow_paid: boolean; max_cost_usd?: number; output_dir?: string },
  estimate: Awaited<ReturnType<typeof estimateImage>>,
  payload: Omit<
    ImageJobPayload,
    | 'estimateUsd'
    | 'estimateSource'
    | 'estimateDetails'
    | 'estimateUnknownCost'
    | 'maxCostUsd'
    | 'maxCostPerRequestUsd'
    | 'maxTotalSpendUsd'
    | 'allowUnknownCost'
    | 'outputRoot'
    | 'resolvedOutputDir'
  >,
  fingerprintInput: unknown,
) {
  deps.costs.validate(estimate, {
    allowPaid: args.allow_paid,
    ...(args.max_cost_usd !== undefined ? { maxCostUsd: args.max_cost_usd } : {}),
  });
  const output = await deps.assets.outputDirectory(args.output_dir, 'image');
  const result = deps.imageQueue.enqueue(
    {
      ...payload,
      outputRoot: output.root,
      resolvedOutputDir: output.directory,
      estimateUsd: estimate.estimateUsd,
      estimateSource: estimate.source,
      estimateDetails: estimate,
      estimateUnknownCost: estimate.estimateUsd === null,
      maxCostUsd: args.max_cost_usd ?? deps.config.maxCostPerRequestUsd,
      maxCostPerRequestUsd: deps.config.maxCostPerRequestUsd,
      maxTotalSpendUsd: deps.config.maxTotalSpendUsd,
      allowUnknownCost: deps.config.allowUnknownCost,
    },
    fingerprintInput,
  );
  return outputJobResult(result.job, result.duplicate);
}

export function registerImageTools(server: McpServer, deps: ImageDeps): void {
  const generateSchema = imageBase.extend({
    n: z.number().int().min(1).max(deps.config.maxImageVariations).default(1),
  });
  const editSchema = imageBase.extend({ input_image_path: z.string().min(1) });
  const variationsSchema = imageBase.extend({
    input_image_path: z.string().min(1).optional(),
    count: z.number().int().min(1).max(deps.config.maxImageVariations).default(2),
  });

  const generate = async (args: z.infer<typeof generateSchema>) =>
    safely(async () => {
      const model = await deps.registry.image(args.model ?? deps.config.defaultImageModel);
      validateImageModel(model, {
        aspect_ratio: args.aspect_ratio,
        resolution: args.resolution,
        size: args.size,
        n: args.n,
      });
      const estimate = await estimateImage(deps, model, args.n, 'generate', {
        resolution: args.resolution,
        aspectRatio: args.aspect_ratio,
      });
      const body = requestBody(model.id, args.prompt, {
        ...args,
        ...(capability(model, 'n') ? { n: args.n } : {}),
      });
      if (args.dry_run)
        return {
          success: true,
          dry_run: true,
          model: model.id,
          estimate,
          request: body,
          job_worker_required: true,
        };
      return enqueue(
        deps,
        args,
        estimate,
        {
          operation: 'generate_image',
          model: model.id,
          prompt: args.prompt,
          requestBodies: [body],
          outputDir: args.output_dir,
          filename: args.filename,
          expectedOutputCount: args.n,
        },
        body,
      );
    });

  server.registerTool(
    'start_image_job',
    {
      description:
        'Valida e enfileira uma geração de imagem persistente. Retorna job_id rapidamente; apenas o worker independente executa o POST pago.',
      inputSchema: generateSchema,
    },
    generate,
  );
  server.registerTool(
    'generate_image',
    {
      description:
        'Compatibilidade: enfileira uma geração de imagem persistente e retorna job_id. Consulte get_image_job_status para obter os ficheiros.',
      inputSchema: generateSchema,
    },
    generate,
  );

  const edit = async (args: z.infer<typeof editSchema>) =>
    safely(async () => {
      const model = await deps.registry.image(args.model ?? deps.config.defaultImageModel);
      const input = await deps.assets.readInputImage(args.input_image_path);
      validateImageModel(model, {
        aspect_ratio: args.aspect_ratio,
        resolution: args.resolution,
        size: args.size,
        references: 1,
      });
      const estimate = await estimateImage(deps, model, 1, 'edit', {
        resolution: args.resolution,
        aspectRatio: args.aspect_ratio,
        referenceCount: 1,
      });
      const body = requestBody(model.id, args.prompt, { ...args, reference: input.dataUrl });
      if (args.dry_run)
        return {
          success: true,
          dry_run: true,
          model: model.id,
          input_image_path: input.absolutePath,
          estimate,
          request: redactedBody(body),
          job_worker_required: true,
        };
      const sourceAsset = (await deps.store.assets()).find((asset) => asset.path === input.absolutePath);
      return enqueue(
        deps,
        args,
        estimate,
        {
          operation: 'edit_image',
          model: model.id,
          prompt: args.prompt,
          requestBodies: [body],
          outputDir: args.output_dir,
          filename: args.filename,
          sourcePath: input.absolutePath,
          expectedOutputCount: 1,
          ...(sourceAsset ? { relatedAssetId: sourceAsset.id } : {}),
        },
        {
          ...body,
          input_references: [
            {
              type: 'image_url',
              image_url: { url: `sha256:${createHash('sha256').update(input.bytes).digest('hex')}` },
            },
          ],
        },
      );
    });

  server.registerTool(
    'start_image_edit_job',
    {
      description:
        'Valida e enfileira uma edição de imagem persistente. Os bytes de entrada ficam no armazenamento local protegido até o worker executar o POST.',
      inputSchema: editSchema,
    },
    edit,
  );
  server.registerTool(
    'edit_image',
    {
      description:
        'Compatibilidade: enfileira uma edição de imagem persistente e retorna job_id. Consulte get_image_job_status para obter os ficheiros.',
      inputSchema: editSchema,
    },
    edit,
  );

  const variations = async (args: z.infer<typeof variationsSchema>) =>
    safely(async () => {
      const model = await deps.registry.image(args.model ?? deps.config.defaultImageModel);
      const input = args.input_image_path
        ? await deps.assets.readInputImage(args.input_image_path)
        : undefined;
      const maxN = Number((capability(model, 'n') as { max?: unknown } | undefined)?.max ?? 1);
      const perCallCount = maxN >= args.count ? args.count : 1;
      validateImageModel(model, {
        aspect_ratio: args.aspect_ratio,
        resolution: args.resolution,
        size: args.size,
        n: perCallCount,
        references: input ? 1 : undefined,
      });
      const estimate = await estimateImage(deps, model, args.count, 'variation', {
        resolution: args.resolution,
        aspectRatio: args.aspect_ratio,
        referenceCount: input ? 1 : 0,
      });
      const callCount = perCallCount === args.count ? 1 : args.count;
      const bodies = Array.from({ length: callCount }, (_, call) =>
        requestBody(
          model.id,
          perCallCount > 1 || call === 0 ? args.prompt : `${args.prompt} — variação ${call + 1}`,
          {
            aspect_ratio: args.aspect_ratio,
            resolution: args.resolution,
            size: args.size,
            ...(perCallCount > 1 ? { n: args.count } : {}),
            ...(input ? { reference: input.dataUrl } : {}),
          },
        ),
      );
      if (args.dry_run)
        return {
          success: true,
          dry_run: true,
          model: model.id,
          count: args.count,
          estimate,
          calls: bodies.map(redactedBody),
          job_worker_required: true,
        };
      const sourceAsset = input
        ? (await deps.store.assets()).find((asset) => asset.path === input.absolutePath)
        : undefined;
      return enqueue(
        deps,
        args,
        estimate,
        {
          operation: 'generate_variations',
          model: model.id,
          prompt: args.prompt,
          requestBodies: bodies,
          outputDir: args.output_dir,
          filename: args.filename,
          expectedOutputCount: args.count,
          ...(input ? { sourcePath: input.absolutePath } : {}),
          ...(sourceAsset ? { relatedAssetId: sourceAsset.id } : {}),
        },
        bodies.map((body) =>
          input
            ? {
                ...body,
                input_references: [
                  {
                    type: 'image_url',
                    image_url: { url: `sha256:${createHash('sha256').update(input.bytes).digest('hex')}` },
                  },
                ],
              }
            : body,
        ),
      );
    });

  server.registerTool(
    'generate_variations',
    {
      description:
        'Compatibilidade: enfileira o conjunto de variações como um job durável; cada POST é acompanhado e não repetido após incerteza.',
      inputSchema: variationsSchema,
    },
    variations,
  );

  server.registerTool(
    'get_image_job_status',
    {
      description: 'Consulta fase, entrega, custo conhecido, erros e caminhos de saída de um job local.',
      inputSchema: z.object({ job_id: z.string().uuid() }),
    },
    async ({ job_id }) =>
      safely(async () => {
        const job = deps.imageQueue.get(job_id);
        if (!job) throw new AppError('Job de imagem não encontrado.', 'IMAGE_JOB_NOT_FOUND');
        return {
          success: true,
          job: publicJob(job),
          response_capture: deps.imageQueue.responseCapture(job_id),
          events: deps.imageQueue.events(job_id),
        };
      }),
  );

  server.registerTool(
    'list_image_jobs',
    {
      description: 'Lista jobs de imagem e reservas legadas sem alterá-las. Use estado para filtrar.',
      inputSchema: z.object({
        status: z
          .enum(['queued', 'running', 'completed', 'failed', 'uncertain', 'reconciliation_required'])
          .optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    },
    async ({ status, limit }) =>
      safely(async () => {
        const jobs = deps.imageQueue
          .list(status as ImageJobStatus | undefined, limit)
          .map((job) => publicJob(deps.imageQueue.get(job.id)));
        const legacyRequests = (await deps.store.paidRequests()).map((request) => ({
          id: request.id,
          operation: request.operation,
          state: request.state,
          created_at: request.createdAt,
          budget_usd: request.budgetUsd,
          unknown_cost: request.unknownCost,
        }));
        return { success: true, count: jobs.length, jobs, legacy_paid_requests: legacyRequests };
      }),
  );

  server.registerTool(
    'recover_image_job_response',
    {
      description:
        'Volta a interpretar localmente uma resposta HTTP 200 preservada e tenta entregar os ficheiros. Só relê dados locais; nunca envia outro POST ao OpenRouter.',
      inputSchema: z.object({ job_id: z.string().uuid() }),
    },
    async ({ job_id }) =>
      safely(async () => {
        deps.imageQueue.recoverPreservedResponse(job_id);
        return {
          success: true,
          accepted: true,
          job_id,
          network_post: false,
          message: 'Recuperação local enfileirada. O worker vai reler a resposta preservada sem gerar novamente.',
        };
      }),
  );

  server.registerTool(
    'reconcile_image_job',
    {
      description:
        'Regista uma reconciliação financeira manual com evidência. Nunca reenvia o POST nem apaga o histórico.',
      inputSchema: z.object({
        job_id: z.string().uuid(),
        decision: z.enum(['confirm_charged', 'confirm_not_charged']),
        evidence: z.string().trim().min(8).max(2_000),
        actual_cost_usd: z.number().min(0).optional(),
      }),
    },
    async ({ job_id, decision, evidence, actual_cost_usd }) =>
      safely(async () => {
        const job = deps.imageQueue.get(job_id);
        if (!job) throw new AppError('Job de imagem não encontrado.', 'IMAGE_JOB_NOT_FOUND');
        if (decision === 'confirm_charged' && actual_cost_usd === undefined)
          throw new AppError(
            'Confirmação de cobrança requer actual_cost_usd verificado.',
            'RECONCILIATION_COST_REQUIRED',
          );
        if (decision === 'confirm_charged') {
          await deps.store.completePaidRequest(job.requestId, {
            at: new Date().toISOString(),
            model: job.model,
            costUsd: actual_cost_usd!,
            budgetUsd: actual_cost_usd!,
            unknownCost: false,
            operation: job.operation,
            jobId: job.id,
          });
        } else await deps.store.releasePaidRequest(job.requestId);
        deps.imageQueue.reconcile(job_id, decision, evidence, actual_cost_usd);
        return { success: true, job: publicJob(deps.imageQueue.get(job_id)), retry_scheduled: false };
      }),
  );
}
