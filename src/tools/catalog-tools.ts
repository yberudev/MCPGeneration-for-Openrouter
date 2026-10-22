import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AppConfig } from '../config/env.js';
import type { AssetManager } from '../services/asset-manager.js';
import type { CostGuard } from '../services/cost-guard.js';
import type { ModelRegistry } from '../services/model-registry.js';
import { safely } from './result.js';
import { AppError } from '../utils/errors.js';

interface CatalogDeps {
  config: AppConfig;
  registry: ModelRegistry;
  assets: AssetManager;
  costs: CostGuard;
}

export function registerCatalogTools(server: McpServer, deps: CatalogDeps): void {
  server.registerTool(
    'list_models',
    {
      description:
        'Consulta os catálogos atuais de modelos de imagem e vídeo do OpenRouter. Expõe somente capacidades e preços publicados pelos endpoints.',
      inputSchema: z.object({
        type: z.enum(['image', 'video', 'all']).default('all'),
        search: z.string().trim().optional(),
        refresh: z.boolean().default(false),
      }),
    },
    async ({ type, search, refresh }) =>
      safely(async () => {
        const needle = search?.toLowerCase();
        const matches = (model: { id: string; name?: string; description?: string }) =>
          !needle ||
          `${model.id} ${model.name ?? ''} ${model.description ?? ''}`.toLowerCase().includes(needle);
        const images =
          type === 'video'
            ? []
            : (await deps.registry.images(refresh)).filter(matches).map((model) => ({
                id: model.id,
                name: model.name ?? null,
                type: 'image',
                description: model.description ?? null,
                modalities: model.architecture ?? null,
                capabilities: model.supported_parameters ?? {},
                pricing: null,
                pricing_endpoint: model.endpoints ?? null,
              }));
        const videos =
          type === 'image'
            ? []
            : (await deps.registry.videos(refresh)).filter(matches).map((model) => ({
                id: model.id,
                name: model.name ?? null,
                type: 'video',
                description: model.description ?? null,
                capabilities: {
                  resolutions: model.supported_resolutions ?? null,
                  aspect_ratios: model.supported_aspect_ratios ?? null,
                  sizes: model.supported_sizes ?? null,
                  durations_seconds: model.supported_durations ?? null,
                  frame_images: model.supported_frame_images ?? null,
                  generate_audio: model.generate_audio ?? null,
                  seed: model.seed ?? null,
                  passthrough_parameters: model.allowed_passthrough_parameters ?? null,
                },
                pricing: model.pricing_skus ?? null,
              }));
        return { success: true, type, count: images.length + videos.length, models: [...images, ...videos] };
      }),
  );

  server.registerTool(
    'estimate_cost',
    {
      description:
        'Estima o custo com metadados atuais do OpenRouter. Devolve unknown quando os catálogos não permitem um cálculo fiável; não usa uma tabela fixa.',
      inputSchema: z.object({
        type: z.enum(['image', 'video']),
        model: z.string().trim().min(1),
        operation: z.enum(['generate', 'edit', 'variation', 'animate']).default('generate'),
        resolution: z.string().trim().optional(),
        aspect_ratio: z.string().trim().optional(),
        duration: z.number().int().positive().optional(),
        count: z.number().int().min(1).max(deps.config.maxImageVariations).default(1),
        reference_image_count: z.number().int().min(0).max(20).default(0),
        generate_audio: z.boolean().default(false),
      }),
    },
    async (args) =>
      safely(async () => {
        if (args.type === 'image') {
          if (args.operation === 'animate')
            throw new AppError(
              'A operação animate pertence ao catálogo de vídeo.',
              'INVALID_ESTIMATE_OPERATION',
            );
          const model = await deps.registry.image(args.model);
          const supported = model.supported_parameters ?? {};
          const references =
            args.operation === 'edit' ? Math.max(1, args.reference_image_count) : args.reference_image_count;
          if (references > 0) {
            const rule = supported.input_references as { min?: unknown; max?: unknown } | undefined;
            const max = Number(rule?.max ?? 0);
            const min = Number(rule?.min ?? 0);
            if (!rule || references < min || references > max)
              throw new AppError(
                `${model.id} não declara suporte a ${references} imagem(ns) de referência.`,
                'IMAGE_REFERENCE_UNSUPPORTED',
              );
          }
          if (args.count > 1) {
            const n = supported.n as { max?: unknown } | undefined;
            const max = Number(n?.max ?? 1);
            if (args.count > deps.config.maxImageVariations)
              throw new AppError('A quantidade excede MAX_IMAGE_VARIATIONS.', 'VARIATION_LIMIT');
            if (args.operation !== 'variation' && (!Number.isFinite(max) || args.count > max))
              throw new AppError(
                `${model.id} não suporta ${args.count} imagens numa única chamada.`,
                'UNSUPPORTED_IMAGE_COUNT',
              );
          }
          for (const [key, value] of Object.entries({
            resolution: args.resolution,
            aspect_ratio: args.aspect_ratio,
          })) {
            if (!value) continue;
            const rule = supported[key];
            if (!rule)
              throw new AppError(`${model.id} não publica suporte a ${key}.`, 'UNSUPPORTED_PARAMETER');
            if (
              typeof rule === 'object' &&
              rule !== null &&
              'values' in rule &&
              Array.isArray((rule as { values?: unknown }).values) &&
              !(rule as { values: unknown[] }).values.includes(value)
            ) {
              throw new AppError(
                `${key}=${value} não é publicado para ${model.id}.`,
                'UNSUPPORTED_PARAMETER_VALUE',
              );
            }
          }
          let pricing: unknown;
          try {
            pricing = await deps.registry.imagePricing(model);
          } catch {
            /* return unknown rather than inventing */
          }
          const estimate = deps.costs.imageEstimate(
            model,
            pricing,
            args.count,
            args.operation === 'variation' ? 'variation' : args.operation === 'edit' ? 'edit' : 'generate',
          );
          return { success: true, ...estimate };
        }

        if (args.operation === 'edit' || args.operation === 'variation')
          throw new AppError(
            'Operações de edição e variação usam o catálogo de imagem.',
            'INVALID_ESTIMATE_OPERATION',
          );
        const model = await deps.registry.video(args.model);
        if (args.operation === 'animate' && !model.supported_frame_images?.includes('first_frame'))
          throw new AppError(
            `${model.id} não publica suporte a frame_images.first_frame.`,
            'IMAGE_TO_VIDEO_UNSUPPORTED',
          );
        if (
          args.duration !== undefined &&
          (!model.supported_durations || !model.supported_durations.includes(args.duration))
        )
          throw new AppError(
            `Duração ${args.duration}s não publicada para ${model.id}.`,
            'UNSUPPORTED_VIDEO_DURATION',
          );
        if (
          args.resolution !== undefined &&
          (!model.supported_resolutions || !model.supported_resolutions.includes(args.resolution))
        )
          throw new AppError(`Resolução não publicada para ${model.id}.`, 'UNSUPPORTED_VIDEO_RESOLUTION');
        if (
          args.aspect_ratio !== undefined &&
          (!model.supported_aspect_ratios || !model.supported_aspect_ratios.includes(args.aspect_ratio))
        )
          throw new AppError(`Proporção não publicada para ${model.id}.`, 'UNSUPPORTED_VIDEO_ASPECT_RATIO');
        if (args.generate_audio && model.generate_audio !== true)
          throw new AppError(`O catálogo não confirma áudio para ${model.id}.`, 'UNSUPPORTED_VIDEO_AUDIO');
        const estimate = deps.costs.videoEstimate(model, {
          duration:
            args.duration ??
            (model.supported_durations?.length ? Math.min(...model.supported_durations) : undefined),
          resolution:
            args.resolution ??
            [...(model.supported_resolutions ?? [])].sort((a, b) => {
              const score = (value: string) => {
                const match = value.match(/^(\d+(?:\.\d+)?)(k|p)?$/i);
                if (!match) return Number.MAX_SAFE_INTEGER;
                const amount = Number(match[1]);
                return match[2]?.toLowerCase() === 'k' ? amount * 1_000 : amount;
              };
              return score(a) - score(b);
            })[0],
          aspectRatio: args.aspect_ratio,
          count: args.count,
          imageReferences:
            args.operation === 'animate'
              ? Math.max(1, args.reference_image_count)
              : args.reference_image_count,
          generateAudio: args.generate_audio,
        });
        return { success: true, ...estimate };
      }),
  );

  server.registerTool(
    'list_assets',
    {
      description: 'Lista metadados de imagens e vídeos gerados pelo MCP, sem devolver conteúdo binário.',
      inputSchema: z.object({
        type: z.enum(['image', 'video', 'all']).default('all'),
        limit: z.number().int().min(1).max(500).default(100),
        project_root: z.string().trim().min(1).optional(),
      }),
    },
    async ({ type, limit, project_root }) =>
      safely(async () => {
        const assets = await deps.assets.list(type, limit, project_root);
        return {
          success: true,
          count: assets.length,
          assets: assets.map((asset) => ({
            id: asset.id,
            name: asset.name,
            path: asset.path,
            relative_path: asset.relativePath,
            type: asset.type,
            mime_type: asset.mimeType,
            model: asset.model,
            created_at: asset.createdAt,
            size_bytes: asset.sizeBytes,
            cost_usd: asset.costUsd,
            generation_id: asset.generationId ?? asset.jobId ?? null,
            related_asset_id: asset.relatedAssetId ?? null,
            related_asset_path: asset.relatedAssetPath ?? null,
          })),
        };
      }),
  );
}
