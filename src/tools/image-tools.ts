import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AppConfig } from '../config/env.js';
import type { OpenRouterClient } from '../providers/openrouter/client.js';
import type { ImageGenerationResponse, ImageModel, OpenRouterImageRequest } from '../types/openrouter.js';
import { AppError, errorForUser } from '../utils/errors.js';
import type { AssetManager } from '../services/asset-manager.js';
import type { CostGuard } from '../services/cost-guard.js';
import type { MetadataStore } from '../services/metadata-store.js';
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
}

function capability(model: ImageModel, key: string): unknown {
  return model.supported_parameters?.[key];
}

function validateImageModel(
  model: ImageModel,
  args: { aspect_ratio?: string; resolution?: string; size?: string; n?: number; references?: number },
): void {
  if (!model.architecture?.output_modalities?.includes('image')) {
    throw new AppError(
      `O modelo ${model.id} não declara saída de imagem no catálogo.`,
      'MODEL_CAPABILITY_MISMATCH',
    );
  }
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
      Array.isArray((rule as { values?: unknown }).values)
    ) {
      if (!(rule as { values: unknown[] }).values.includes(value)) {
        throw new AppError(
          `${key}=${value} não é suportado por ${model.id}. Valores publicados: ${(rule as { values: unknown[] }).values.join(', ')}.`,
          'UNSUPPORTED_PARAMETER_VALUE',
        );
      }
    }
    if (
      key === 'size' &&
      typeof rule === 'object' &&
      rule !== null &&
      'type' in rule &&
      (rule as { type: unknown }).type === 'boolean'
    ) {
      throw new AppError(
        `O catálogo indica que ${model.id} aceita size, mas não publica dimensões concretas; não é seguro inventar um valor.`,
        'UNVERIFIED_PARAMETER',
      );
    }
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
  if (args.references && args.references > 0) {
    const rule = capability(model, 'input_references');
    const max =
      typeof rule === 'object' && rule !== null && 'max' in rule ? Number((rule as { max: unknown }).max) : 0;
    const min =
      typeof rule === 'object' && rule !== null && 'min' in rule ? Number((rule as { min: unknown }).min) : 0;
    if (!rule || args.references > max || args.references < min) {
      throw new AppError(
        `O modelo ${model.id} não aceita ${args.references} imagem(ns) de referência.`,
        'IMAGE_REFERENCE_UNSUPPORTED',
      );
    }
  }
}

async function estimateImage(
  deps: ImageDeps,
  model: ImageModel,
  count: number,
  operation: 'generate' | 'edit' | 'variation',
) {
  let pricing: unknown;
  try {
    pricing = await deps.registry.imagePricing(model);
  } catch {
    /* unavailable metadata is returned as unknown */
  }
  return deps.costs.imageEstimate(model, pricing, count, operation);
}

function requestBody(
  model: string,
  prompt: string,
  options: {
    aspect_ratio?: string;
    resolution?: string;
    size?: string;
    n?: number;
    reference?: string;
  },
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

function decodeBase64(value: string, maxBytes: number): Buffer {
  if (
    Math.ceil(value.length * 0.75) > maxBytes ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new AppError(
      'A resposta contém base64 inválido ou excede o limite de tamanho.',
      'INVALID_IMAGE_DATA',
    );
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maxBytes)
    throw new AppError('A resposta de imagem está vazia ou excede o limite.', 'INVALID_IMAGE_DATA');
  return bytes;
}

function parseImageResponse(response: ImageGenerationResponse, maxBytes: number): Buffer[] {
  if (!Array.isArray(response.data) || response.data.length === 0)
    throw new AppError('A resposta não contém imagens geradas.', 'IMAGE_RESPONSE_EMPTY');
  const outputs: Buffer[] = [];
  for (const entry of response.data) {
    if (typeof entry.b64_json !== 'string') continue;
    try {
      outputs.push(decodeBase64(entry.b64_json, maxBytes));
    } catch {
      /* keep other valid results */
    }
  }
  if (!outputs.length)
    throw new AppError('A resposta não contém dados b64_json de imagem.', 'IMAGE_RESPONSE_EMPTY');
  return outputs;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function recordUncertainImage(
  deps: ImageDeps,
  intentId: string,
  model: string,
  estimateUsd: number | null,
  operation: string,
  error: unknown,
): Promise<void> {
  if (isUncertainImagePost(error)) {
    await deps.store.markPaidRequestUncertain(intentId, {
      model,
      estimateUsd,
      operation: `${operation}_uncertain`,
    });
  } else await deps.store.releasePaidRequest(intentId);
}

function isUncertainImagePost(error: unknown): boolean {
  const code = error instanceof AppError ? error.code : '';
  return (
    code === 'NETWORK_ERROR' ||
    code === 'INVALID_RESPONSE' ||
    code === 'RESPONSE_TOO_LARGE' ||
    code.startsWith('OPENROUTER_HTTP_5')
  );
}

async function paidImageCall(
  deps: ImageDeps,
  body: OpenRouterImageRequest,
  intentId: string,
  estimateUsd: number | null,
  operation: string,
): Promise<ImageGenerationResponse> {
  try {
    return await deps.client.generateImage(body);
  } catch (error) {
    await recordUncertainImage(deps, intentId, body.model, estimateUsd, operation, error);
    throw error;
  }
}

async function completeImageIntent(
  deps: ImageDeps,
  intentId: string,
  args: { model: string; estimateUsd: number | null; actualCost?: number; operation: string },
): Promise<void> {
  await deps.store.completePaidRequest(intentId, {
    at: new Date().toISOString(),
    model: args.model,
    costUsd: args.actualCost ?? 0,
    budgetUsd: args.actualCost ?? args.estimateUsd ?? 0,
    unknownCost: args.actualCost === undefined && args.estimateUsd === null,
    operation: args.operation,
  });
}

export function registerImageTools(server: McpServer, deps: ImageDeps): void {
  server.registerTool(
    'generate_image',
    {
      description:
        'Gera imagens pelo endpoint dedicado /images do OpenRouter, valida o modelo e guarda cada resultado dentro de uma raiz local autorizada. A geração exige allow_paid=true.',
      inputSchema: imageBase.extend({
        n: z.number().int().min(1).max(deps.config.maxImageVariations).default(1),
      }),
    },
    async (args) =>
      safely(async () => {
        const model = await deps.registry.image(args.model ?? deps.config.defaultImageModel);
        validateImageModel(model, {
          aspect_ratio: args.aspect_ratio,
          resolution: args.resolution,
          size: args.size,
          n: args.n,
        });
        const estimate = await estimateImage(deps, model, args.n, 'generate');
        if (args.dry_run)
          return {
            success: true,
            dry_run: true,
            model: model.id,
            estimate,
            request: requestBody(model.id, args.prompt, {
              ...args,
              ...(capability(model, 'n') ? { n: args.n } : {}),
            }),
          };
        await deps.assets.outputDirectory(args.output_dir, 'image');
        const body = requestBody(model.id, args.prompt, {
          ...args,
          ...(capability(model, 'n') ? { n: args.n } : {}),
        });
        const intentId = await deps.costs.authorize(
          estimate,
          {
            allowPaid: args.allow_paid,
            ...(args.max_cost_usd !== undefined ? { maxCostUsd: args.max_cost_usd } : {}),
          },
          'generate_image',
          fingerprint(body),
        );
        const response = await paidImageCall(deps, body, intentId, estimate.estimateUsd, 'generate_image');
        const actualCost = typeof response.usage?.cost === 'number' ? response.usage.cost : undefined;
        await completeImageIntent(deps, intentId, {
          model: model.id,
          estimateUsd: estimate.estimateUsd,
          actualCost,
          operation: 'generate_image',
        });
        const images = parseImageResponse(response, deps.config.maxImageBytes);
        const generationId = randomUUID();
        const files = [];
        for (let i = 0; i < images.length; i += 1) {
          const name = args.filename
            ? images.length > 1
              ? `${args.filename.replace(/\.[^.]+$/, '')}-${String(i + 1).padStart(2, '0')}${args.filename.match(/\.[^.]+$/)?.[0] ?? ''}`
              : args.filename
            : undefined;
          const file = await deps.assets.saveImage({
            bytes: images[i]!,
            filename: name,
            outputDir: args.output_dir,
            model: model.id,
            prompt: args.prompt,
            costUsd: i === 0 ? (actualCost ?? null) : null,
            generationId,
            parameters: {
              ...(args.aspect_ratio ? { aspect_ratio: args.aspect_ratio } : {}),
              ...(args.resolution ? { resolution: args.resolution } : {}),
            },
          });
          files.push({
            path: file.absolutePath,
            relative_path: file.relativePath,
            mime_type: file.mimeType,
            size_bytes: file.sizeBytes,
            ...(file.parameters?.width
              ? { width: file.parameters.width, height: file.parameters.height }
              : {}),
          });
        }
        return {
          success: true,
          generation_id: generationId,
          model: model.id,
          files,
          count: files.length,
          usage: {
            cost_usd: actualCost ?? null,
            estimate_usd: estimate.estimateUsd,
            source: actualCost !== undefined ? 'openrouter_usage' : estimate.source,
          },
        };
      }),
  );

  server.registerTool(
    'edit_image',
    {
      description:
        'Edita uma imagem local usando input_references do endpoint /images. A origem permanece intacta e a imagem editada é guardada como novo recurso.',
      inputSchema: imageBase.extend({ input_image_path: z.string().min(1) }),
    },
    async (args) =>
      safely(async () => {
        const model = await deps.registry.image(args.model ?? deps.config.defaultImageModel);
        const input = await deps.assets.readInputImage(args.input_image_path);
        validateImageModel(model, {
          aspect_ratio: args.aspect_ratio,
          resolution: args.resolution,
          size: args.size,
          references: 1,
        });
        const estimate = await estimateImage(deps, model, 1, 'edit');
        if (args.dry_run) {
          const request = requestBody(model.id, args.prompt, {
            ...args,
            reference: `[data URL ${input.info.mimeType} omitida em dry_run]`,
          });
          return {
            success: true,
            dry_run: true,
            model: model.id,
            input_image_path: input.absolutePath,
            estimate,
            request,
          };
        }
        await deps.assets.outputDirectory(args.output_dir, 'image');
        const body = requestBody(model.id, args.prompt, { ...args, reference: input.dataUrl });
        const intentId = await deps.costs.authorize(
          estimate,
          {
            allowPaid: args.allow_paid,
            ...(args.max_cost_usd !== undefined ? { maxCostUsd: args.max_cost_usd } : {}),
          },
          'edit_image',
          fingerprint(body),
        );
        const response = await paidImageCall(deps, body, intentId, estimate.estimateUsd, 'edit_image');
        const cost = typeof response.usage?.cost === 'number' ? response.usage.cost : undefined;
        await completeImageIntent(deps, intentId, {
          model: model.id,
          estimateUsd: estimate.estimateUsd,
          actualCost: cost,
          operation: 'edit_image',
        });
        const images = parseImageResponse(response, deps.config.maxImageBytes);
        const generationId = randomUUID();
        const sourceAsset = (await deps.store.assets()).find((asset) => asset.path === input.absolutePath);
        const files = [];
        for (let i = 0; i < images.length; i += 1) {
          const file = await deps.assets.saveImage({
            bytes: images[i]!,
            filename: args.filename,
            outputDir: args.output_dir,
            model: model.id,
            prompt: args.prompt,
            costUsd: i === 0 ? (cost ?? null) : null,
            generationId,
            relatedAssetPath: input.absolutePath,
            ...(sourceAsset ? { relatedAssetId: sourceAsset.id } : {}),
            parameters: { input_image_path: input.absolutePath },
          });
          files.push({ path: file.absolutePath, relative_path: file.relativePath, mime_type: file.mimeType });
        }
        return {
          success: true,
          generation_id: generationId,
          model: model.id,
          source: input.absolutePath,
          files,
          usage: { cost_usd: cost ?? null, estimate_usd: estimate.estimateUsd },
        };
      }),
  );

  server.registerTool(
    'generate_variations',
    {
      description:
        'Gera um conjunto limitado de variações de um prompt ou imagem. Usa n quando publicado pelo modelo; caso contrário envia exatamente count pedidos, após autorização explícita.',
      inputSchema: imageBase.extend({
        input_image_path: z.string().min(1).optional(),
        count: z.number().int().min(1).max(deps.config.maxImageVariations).default(2),
      }),
    },
    async (args) =>
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
        const estimate = await estimateImage(deps, model, args.count, 'variation');
        if (args.dry_run)
          return {
            success: true,
            dry_run: true,
            model: model.id,
            count: args.count,
            estimate,
            calls: perCallCount === args.count ? 1 : args.count,
          };
        await deps.assets.outputDirectory(args.output_dir, 'image');
        const results: Array<{ bytes: Buffer; cost?: number }> = [];
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
        const intentId = await deps.costs.authorize(
          estimate,
          {
            allowPaid: args.allow_paid,
            ...(args.max_cost_usd !== undefined ? { maxCostUsd: args.max_cost_usd } : {}),
          },
          'generate_variations',
          fingerprint(bodies),
        );
        const actualCosts: number[] = [];
        let acceptedCalls = 0;
        let successfulCalls = 0;
        let failure: unknown;
        for (let call = 0; call < callCount; call += 1) {
          try {
            const response = await deps.client.generateImage(bodies[call]!);
            acceptedCalls += 1;
            const bytes = parseImageResponse(response, deps.config.maxImageBytes);
            successfulCalls += 1;
            const responseCost = typeof response.usage?.cost === 'number' ? response.usage.cost : undefined;
            if (responseCost !== undefined) actualCosts.push(responseCost);
            for (const image of bytes)
              results.push({
                bytes: image,
                ...(responseCost !== undefined ? { cost: responseCost / bytes.length } : {}),
              });
          } catch (error) {
            failure = error;
            break;
          }
        }
        if (failure && results.length === 0) {
          if (acceptedCalls > successfulCalls) {
            await deps.store.markPaidRequestUncertain(intentId, {
              model: model.id,
              estimateUsd: estimate.estimateUsd,
              operation: 'generate_variations_uncertain',
            });
          } else {
            await recordUncertainImage(
              deps,
              intentId,
              model.id,
              estimate.estimateUsd,
              'generate_variations',
              failure,
            );
          }
          throw failure;
        }
        const actualCost =
          actualCosts.length === successfulCalls
            ? actualCosts.reduce((sum, value) => sum + value, 0)
            : undefined;
        const uncertainFailure =
          Boolean(failure) && (isUncertainImagePost(failure) || acceptedCalls > successfulCalls);
        if (failure && uncertainFailure) {
          await deps.store.markPaidRequestUncertain(intentId, {
            model: model.id,
            estimateUsd: estimate.estimateUsd,
            operation: 'generate_variations_uncertain',
          });
        } else {
          await completeImageIntent(deps, intentId, {
            model: model.id,
            estimateUsd: estimate.estimateUsd,
            actualCost,
            operation: 'generate_variations',
          });
        }
        const generationId = randomUUID();
        const files = [];
        const sourceAsset = input
          ? (await deps.store.assets()).find((asset) => asset.path === input.absolutePath)
          : undefined;
        for (let i = 0; i < results.length; i += 1) {
          const supplied = args.filename
            ? `${args.filename.replace(/\.[^.]+$/, '')}-${String(i + 1).padStart(2, '0')}${args.filename.match(/\.[^.]+$/)?.[0] ?? ''}`
            : `variation-${generationId.slice(0, 8)}-${String(i + 1).padStart(2, '0')}`;
          const file = await deps.assets.saveImage({
            bytes: results[i]!.bytes,
            filename: supplied,
            outputDir: args.output_dir,
            model: model.id,
            prompt: args.prompt,
            costUsd: results[i]!.cost ?? null,
            generationId,
            ...(input ? { relatedAssetPath: input.absolutePath } : {}),
            ...(sourceAsset ? { relatedAssetId: sourceAsset.id } : {}),
            parameters: { variation: i + 1, count: args.count },
          });
          files.push({ path: file.absolutePath, relative_path: file.relativePath, mime_type: file.mimeType });
        }
        return {
          success: true,
          generation_id: generationId,
          model: model.id,
          ...(failure ? { partial_failure: errorForUser(failure) } : {}),
          ...(uncertainFailure ? { reconciliation_required: true } : {}),
          files,
          count: files.length,
          usage: {
            estimate_usd: estimate.estimateUsd,
            cost_usd: results.reduce((sum, item) => sum + (item.cost ?? 0), 0) || null,
          },
        };
      }),
  );
}
