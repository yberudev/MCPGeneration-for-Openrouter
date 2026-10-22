import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AppConfig } from '../config/env.js';
import type { OpenRouterClient } from '../providers/openrouter/client.js';
import type { VideoJobResponse, VideoModel, OpenRouterVideoRequest } from '../types/openrouter.js';
import { AppError } from '../utils/errors.js';
import type { AssetManager } from '../services/asset-manager.js';
import type { CostGuard } from '../services/cost-guard.js';
import { type CostEstimate } from '../services/cost-guard.js';
import type { JobManager } from '../services/job-manager.js';
import type { MetadataStore } from '../services/metadata-store.js';
import type { ModelRegistry } from '../services/model-registry.js';
import { safely } from './result.js';

const videoBase = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  model: z.string().trim().min(1).optional(),
  duration: z.number().int().min(1).optional(),
  resolution: z.string().trim().min(1).optional(),
  aspect_ratio: z.string().trim().min(1).optional(),
  generate_audio: z.boolean().optional(),
  output_dir: z.string().trim().min(1).optional(),
  filename: z.string().trim().min(1).optional(),
  dry_run: z.boolean().default(false),
  allow_paid: z.boolean().default(false),
  max_cost_usd: z.number().positive().optional(),
});

interface VideoDeps {
  config: AppConfig;
  client: OpenRouterClient;
  registry: ModelRegistry;
  assets: AssetManager;
  costs: CostGuard;
  jobs: JobManager;
  store: MetadataStore;
}

function lowestResolution(values: string[] | null | undefined): string | undefined {
  if (!values?.length) return undefined;
  const score = (value: string) => {
    const match = value.match(/^(\d+(?:\.\d+)?)(k|p)?$/i);
    if (!match) return Number.MAX_SAFE_INTEGER;
    const amount = Number(match[1]);
    return match[2]?.toLowerCase() === 'k' ? amount * 1_000 : amount;
  };
  return [...values].sort((a, b) => {
    return score(a) - score(b);
  })[0];
}

function selectVideoOptions(
  model: VideoModel,
  args: { duration?: number; resolution?: string; aspect_ratio?: string; generate_audio?: boolean },
) {
  const durations = model.supported_durations;
  const duration = args.duration ?? (durations?.length ? Math.min(...durations) : undefined);
  const resolution = args.resolution ?? lowestResolution(model.supported_resolutions);
  const aspectRatio = args.aspect_ratio;
  const generateAudio = args.generate_audio ?? false;
  if (args.duration !== undefined && (!durations || !durations.includes(args.duration))) {
    throw new AppError(
      `Duração ${args.duration}s não aparece entre as capacidades publicadas de ${model.id}.`,
      'UNSUPPORTED_VIDEO_DURATION',
    );
  }
  if (
    args.resolution !== undefined &&
    (!model.supported_resolutions || !model.supported_resolutions.includes(args.resolution))
  ) {
    throw new AppError(
      `Resolução ${args.resolution} não aparece entre as capacidades publicadas de ${model.id}.`,
      'UNSUPPORTED_VIDEO_RESOLUTION',
    );
  }
  if (
    args.aspect_ratio !== undefined &&
    (!model.supported_aspect_ratios || !model.supported_aspect_ratios.includes(args.aspect_ratio))
  ) {
    throw new AppError(
      `Proporção ${args.aspect_ratio} não aparece entre as capacidades publicadas de ${model.id}.`,
      'UNSUPPORTED_VIDEO_ASPECT_RATIO',
    );
  }
  if (generateAudio && model.generate_audio !== true) {
    throw new AppError(
      `O catálogo não confirma geração de áudio para ${model.id}.`,
      'UNSUPPORTED_VIDEO_AUDIO',
    );
  }
  return { duration, resolution, aspectRatio, generateAudio };
}

function validateFrameSupport(model: VideoModel): void {
  if (!model.supported_frame_images?.includes('first_frame')) {
    const compatible =
      'Consulte list_models(type="video") e escolha um modelo cujo supported_frame_images inclua first_frame.';
    throw new AppError(
      `O modelo ${model.id} não publica suporte a frame_images.first_frame. ${compatible}`,
      'IMAGE_TO_VIDEO_UNSUPPORTED',
    );
  }
}

function validateImageUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('input_image_url não é um URL válido.', 'INVALID_IMAGE_URL');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    isIP(hostname) ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new AppError(
      'input_image_url deve ser HTTPS, sem credenciais, fragmento, IP literal ou host local.',
      'UNSAFE_IMAGE_URL',
    );
  }
  return url.toString();
}

function videoBody(
  model: string,
  prompt: string,
  options: {
    duration?: number;
    resolution?: string;
    aspectRatio?: string;
    generateAudio: boolean;
    frameImage?: string;
  },
): OpenRouterVideoRequest {
  return {
    model,
    prompt,
    ...(options.duration !== undefined ? { duration: options.duration } : {}),
    ...(options.resolution ? { resolution: options.resolution } : {}),
    ...(options.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
    generate_audio: options.generateAudio,
    ...(options.frameImage
      ? {
          frame_images: [
            { type: 'image_url', image_url: { url: options.frameImage }, frame_type: 'first_frame' },
          ],
        }
      : {}),
  };
}

function estimateVideo(
  deps: VideoDeps,
  model: VideoModel,
  options: {
    duration?: number;
    resolution?: string;
    aspectRatio?: string;
    generateAudio: boolean;
    frameImageCount: number;
    inputReferenceCount: number;
  },
): CostEstimate {
  return deps.costs.videoEstimate(model, {
    duration: options.duration,
    resolution: options.resolution,
    aspectRatio: options.aspectRatio,
    generateAudio: options.generateAudio,
    frameImageCount: options.frameImageCount,
    inputReferenceCount: options.inputReferenceCount,
  });
}

async function recordVideoUsage(
  deps: VideoDeps,
  args: { model: string; estimateUsd: number | null; actualCost?: number; operation: string; jobId: string },
): Promise<void> {
  const actual = args.actualCost;
  await deps.store.recordUsage({
    at: new Date().toISOString(),
    model: args.model,
    costUsd: actual ?? 0,
    budgetUsd: actual ?? args.estimateUsd ?? 0,
    unknownCost: actual === undefined && args.estimateUsd === null,
    operation: args.operation,
    jobId: args.jobId,
  });
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isUncertainPost(error: unknown): boolean {
  const code = error instanceof AppError ? error.code : '';
  return (
    code === 'NETWORK_ERROR' ||
    code === 'INVALID_RESPONSE' ||
    code === 'RESPONSE_TOO_LARGE' ||
    code === 'MISSING_VIDEO_JOB_ID' ||
    code.startsWith('OPENROUTER_HTTP_5')
  );
}

async function submitVideo(
  deps: VideoDeps,
  args: {
    model: VideoModel;
    prompt: string;
    options: ReturnType<typeof selectVideoOptions>;
    estimate: CostEstimate;
    body: OpenRouterVideoRequest;
    outputDir?: string;
    filename?: string;
    allowPaid: boolean;
    maxCostUsd?: number;
    imagePath?: string;
    imageUrl?: string;
  },
): Promise<Record<string, unknown>> {
  if (args.body && Object.keys(args.body).length === 0)
    throw new AppError('Pedido de vídeo vazio.', 'INVALID_VIDEO_REQUEST');
  if (args.options.duration === undefined || args.options.resolution === undefined) {
    if (args.estimate.estimateUsd !== null)
      throw new AppError(
        'O catálogo não permitiu validar os parâmetros de custo.',
        'UNVERIFIED_VIDEO_DEFAULTS',
      );
  }
  if (!args.allowPaid)
    throw new AppError(
      'Operação paga bloqueada. Defina allow_paid: true para autorizar esta geração.',
      'PAYMENT_NOT_AUTHORIZED',
    );
  const out = await deps.assets.outputDirectory(args.outputDir, 'video');
  const intentId = await deps.costs.authorize(
    args.estimate,
    { allowPaid: args.allowPaid, ...(args.maxCostUsd !== undefined ? { maxCostUsd: args.maxCostUsd } : {}) },
    args.imagePath ? 'animate_image' : 'generate_video',
    fingerprint(args.body),
  );
  let remote: VideoJobResponse;
  try {
    remote = await deps.client.createVideo(args.body);
    if (!remote.id) {
      const missing = new AppError(
        'O OpenRouter não devolveu um identificador de tarefa após aceitar o pedido.',
        'MISSING_VIDEO_JOB_ID',
      );
      await deps.store.markPaidRequestUncertain(intentId, {
        model: args.model.id,
        estimateUsd: args.estimate.estimateUsd,
        operation: 'generate_video_uncertain',
      });
      throw missing;
    }
  } catch (error) {
    if (isUncertainPost(error)) {
      await deps.store.markPaidRequestUncertain(intentId, {
        model: args.model.id,
        estimateUsd: args.estimate.estimateUsd,
        operation: 'generate_video_uncertain',
      });
    } else await deps.store.releasePaidRequest(intentId);
    throw error;
  }
  let job;
  try {
    job = await deps.jobs.create({
      remote,
      model: args.model.id,
      prompt: args.prompt,
      config: {
        ...args.body,
        ...(args.body.frame_images
          ? {
              frame_images: [
                {
                  type: 'image_url',
                  frame_type: 'first_frame',
                  image_url: { url: '[image reference omitted]' },
                },
              ],
            }
          : {}),
        ...(args.imagePath ? { input_image_path: args.imagePath } : {}),
        ...(args.imageUrl ? { input_image_url: '[HTTPS image URL omitted]' } : {}),
        estimate_usd: args.estimate.estimateUsd,
      },
      outputDir: out.directory,
      ...(args.filename ? { filename: args.filename } : {}),
    });
  } catch (error) {
    await deps.store.markPaidRequestUncertain(intentId, {
      model: args.model.id,
      estimateUsd: args.estimate.estimateUsd,
      operation: 'generate_video_persistence_uncertain',
      remoteId: remote.id,
    });
    throw new AppError(
      `O OpenRouter criou a tarefa ${remote.id}, mas a persistência local falhou. A tentativa foi bloqueada contra duplicação; verifique o job antes de recuperar.`,
      'JOB_PERSISTENCE_ERROR',
      { cause: error },
    );
  }
  await deps.store.completePaidRequest(intentId, {
    at: new Date().toISOString(),
    model: args.model.id,
    costUsd: job.costUsd ?? 0,
    budgetUsd: job.costUsd ?? args.estimate.estimateUsd ?? 0,
    unknownCost: job.costUsd === null && args.estimate.estimateUsd === null,
    operation: args.imagePath ? 'animate_image' : 'generate_video',
    jobId: job.id,
  });
  return {
    success: true,
    job_id: job.id,
    remote_job_id: job.remoteId,
    generation_id: remote.generation_id ?? null,
    status: job.status,
    model: job.model,
    created_at: job.createdAt,
    configuration: job.config,
    estimate: args.estimate,
    file_available: false,
  };
}

export function registerVideoTools(server: McpServer, deps: VideoDeps): void {
  server.registerTool(
    'generate_video',
    {
      description:
        'Inicia text-to-video de forma assíncrona, persiste o job antes de devolver e não espera a geração terminar. A geração exige allow_paid=true.',
      inputSchema: videoBase,
    },
    async (args) =>
      safely(async () => {
        const model = await deps.registry.video(args.model ?? deps.config.defaultVideoModel);
        const options = selectVideoOptions(model, args);
        const estimate = estimateVideo(deps, model, {
          ...options,
          frameImageCount: 0,
          inputReferenceCount: 0,
        });
        const body = videoBody(model.id, args.prompt, options);
        if (args.dry_run)
          return { success: true, dry_run: true, model: model.id, configuration: body, estimate };
        return submitVideo(deps, {
          model,
          prompt: args.prompt,
          options,
          estimate,
          body,
          ...(args.output_dir ? { outputDir: args.output_dir } : {}),
          ...(args.filename ? { filename: args.filename } : {}),
          allowPaid: args.allow_paid,
          ...(args.max_cost_usd !== undefined ? { maxCostUsd: args.max_cost_usd } : {}),
        });
      }),
  );

  server.registerTool(
    'animate_image',
    {
      description:
        'Anima uma imagem local como primeiro frame num pedido de vídeo. Só está disponível para modelos que publiquem supported_frame_images.first_frame. O ficheiro é enviado como data URL; os fornecedores podem impor requisitos adicionais de URL pública.',
      inputSchema: videoBase.extend({
        input_image_path: z.string().min(1),
        input_image_url: z.string().url().optional(),
      }),
    },
    async (args) =>
      safely(async () => {
        const model = await deps.registry.video(args.model ?? deps.config.defaultVideoModel);
        validateFrameSupport(model);
        const options = selectVideoOptions(model, args);
        const input = await deps.assets.readInputImage(args.input_image_path);
        const inputImageUrl = args.input_image_url ? validateImageUrl(args.input_image_url) : undefined;
        const estimate = estimateVideo(deps, model, {
          ...options,
          frameImageCount: 1,
          inputReferenceCount: 0,
        });
        const frameImage = inputImageUrl ?? input.dataUrl;
        const body = videoBody(model.id, args.prompt, { ...options, frameImage });
        if (args.dry_run)
          return {
            success: true,
            dry_run: true,
            model: model.id,
            input_image_path: input.absolutePath,
            ...(inputImageUrl ? { input_image_url: '[HTTPS image URL omitted]' } : {}),
            configuration: {
              ...body,
              frame_images: [
                {
                  type: 'image_url',
                  frame_type: 'first_frame',
                  image_url: {
                    url: inputImageUrl
                      ? '[HTTPS image URL omitted]'
                      : `[data URL ${input.info.mimeType} omitida]`,
                  },
                },
              ],
            },
            estimate,
          };
        return submitVideo(deps, {
          model,
          prompt: args.prompt,
          options,
          estimate,
          body,
          ...(args.output_dir ? { outputDir: args.output_dir } : {}),
          ...(args.filename ? { filename: args.filename } : {}),
          allowPaid: args.allow_paid,
          ...(args.max_cost_usd !== undefined ? { maxCostUsd: args.max_cost_usd } : {}),
          imagePath: input.absolutePath,
          ...(inputImageUrl ? { imageUrl: inputImageUrl } : {}),
        });
      }),
  );

  server.registerTool(
    'get_video_status',
    {
      description:
        'Consulta o estado de uma tarefa de vídeo existente pelo ID local ou remoto. Nunca cria uma nova geração.',
      inputSchema: z.object({ job_id: z.string().trim().min(1) }),
    },
    async ({ job_id }) =>
      safely(async () => {
        const job = await deps.jobs.require(job_id);
        const remote = await deps.client.getVideo(job.remoteId);
        const updated = await deps.jobs.update(job, remote);
        if (updated.costUsd !== null && job.costUsd === null) {
          await recordVideoUsage(deps, {
            model: job.model,
            estimateUsd: Number(job.config.estimate_usd ?? 0),
            actualCost: updated.costUsd,
            operation: 'generate_video',
            jobId: job.id,
          });
        }
        const availableFiles = [];
        for (const path of updated.files) if (await deps.assets.exists(path)) availableFiles.push(path);
        return {
          success: true,
          job_id: updated.id,
          remote_job_id: updated.remoteId,
          model: updated.model,
          status: updated.status,
          created_at: updated.createdAt,
          updated_at: updated.updatedAt,
          error: updated.error ?? null,
          cost_usd: updated.costUsd,
          file_available: availableFiles.length > 0,
          files: availableFiles,
        };
      }),
  );

  server.registerTool(
    'download_video',
    {
      description:
        'Descarrega por streaming um vídeo concluído pelo endpoint autenticado /videos/{id}/content. Usa gravação temporária e renomeação exclusiva; não segue URLs externos.',
      inputSchema: z.object({
        job_id: z.string().trim().min(1),
        output_dir: z.string().trim().min(1).optional(),
        filename: z.string().trim().min(1).optional(),
        index: z.number().int().min(0).default(0),
      }),
    },
    async ({ job_id, output_dir, filename, index }) =>
      safely(async () => {
        let job = await deps.jobs.require(job_id);
        const remote = await deps.client.getVideo(job.remoteId);
        job = await deps.jobs.update(job, remote);
        if (job.costUsd !== null) {
          await recordVideoUsage(deps, {
            model: job.model,
            estimateUsd: Number(job.config.estimate_usd ?? 0),
            actualCost: job.costUsd,
            operation: 'generate_video',
            jobId: job.id,
          });
        }
        if (job.status !== 'completed')
          throw new AppError(`A tarefa ainda não está concluída (estado: ${job.status}).`, 'VIDEO_NOT_READY');
        const requestedOutput = output_dir ?? job.outputDir;
        if (!output_dir && !filename) {
          for (const existing of job.files) {
            if (await deps.assets.exists(existing)) {
              const asset = (await deps.store.assets()).find((item) => item.path === existing);
              if (asset)
                return {
                  success: true,
                  idempotent: true,
                  job_id: job.id,
                  path: asset.path,
                  relative_path: asset.relativePath,
                  mime_type: asset.mimeType,
                  size_bytes: asset.sizeBytes,
                  cost_usd: job.costUsd,
                };
            }
          }
        }
        await deps.assets.outputDirectory(requestedOutput, 'video');
        const response = await deps.client.downloadVideo(job.remoteId, index);
        const file = await deps.assets.saveVideoResponse({
          response,
          outputDir: requestedOutput,
          filename: filename ?? job.filename,
          model: job.model,
          prompt: job.prompt,
          costUsd: job.costUsd,
          jobId: job.id,
          parameters: job.config,
        });
        const updated: typeof job = {
          ...job,
          updatedAt: new Date().toISOString(),
          files: [...job.files, file.absolutePath],
        };
        await deps.store.saveJob(updated);
        return {
          success: true,
          idempotent: false,
          job_id: job.id,
          path: file.absolutePath,
          relative_path: file.relativePath,
          mime_type: file.mimeType,
          size_bytes: file.sizeBytes,
          cost_usd: job.costUsd,
        };
      }),
  );
}
