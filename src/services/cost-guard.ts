import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import type { ImageModel, VideoModel } from '../types/openrouter.js';
import type { MetadataStore } from './metadata-store.js';

export interface CostEstimate {
  status: 'estimated' | 'unknown';
  estimateUsd: number | null;
  source: string;
  confidence: 'high' | 'medium' | 'none';
  parameters: Record<string, unknown>;
  limitations: string[];
}

function numeric(value: unknown): number | undefined {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function resolutionToken(value: string | undefined): string | undefined {
  return value?.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export class CostGuard {
  constructor(
    private readonly config: AppConfig,
    private readonly store: MetadataStore,
  ) {}

  imageEstimate(
    model: ImageModel,
    pricing: unknown,
    count: number,
    operation: 'generate' | 'edit' | 'variation',
  ): CostEstimate {
    if (Array.isArray(pricing)) {
      const entries = pricing.filter(
        (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object',
      );
      const perImage = entries.find(
        (item) => ['image', 'request'].includes(String(item.unit)) && numeric(item.cost_usd) !== undefined,
      );
      const price = perImage ? numeric(perImage.cost_usd) : undefined;
      if (price !== undefined) {
        return {
          status: 'estimated',
          estimateUsd: price * count,
          source: 'OpenRouter image model endpoint pricing',
          confidence: 'high',
          parameters: { model: model.id, operation, count, unitPriceUsd: price },
          limitations: ['A faturação final pode variar por fornecedor e parâmetros enviados.'],
        };
      }
    }
    return {
      status: 'unknown',
      estimateUsd: null,
      source: 'OpenRouter image endpoint pricing',
      confidence: 'none',
      parameters: { model: model.id, operation, count },
      limitations: [
        'O catálogo atual usa preços por token ou por unidade que dependem do resultado; não há preço prévio confiável por imagem.',
      ],
    };
  }

  videoEstimate(
    model: VideoModel,
    options: {
      duration?: number;
      resolution?: string;
      count?: number;
      frameImageCount?: number;
      inputReferenceCount?: number;
      generateAudio?: boolean;
      aspectRatio?: string;
    },
  ): CostEstimate {
    const sku = model.pricing_skus ?? {};
    const count = options.count ?? 1;
    const frameImageCount = options.frameImageCount ?? 0;
    const inputReferenceCount = options.inputReferenceCount ?? 0;
    if (frameImageCount > 0 && inputReferenceCount > 0) {
      return this.unknownVideo(
        model,
        options,
        'O catálogo não define uma estimativa combinada para frame_images e input_references no mesmo pedido.',
      );
    }
    const resolution = resolutionToken(options.resolution);
    const inputMode =
      inputReferenceCount > 0 ? 'input_references' : frameImageCount > 0 ? 'frame_images' : 'text';
    const prefix = inputMode === 'input_references' ? 'reference_duration_seconds_' : 'duration_seconds_';
    let rate: number | undefined;
    if (resolution) rate = numeric(sku[`${prefix}${resolution}`]);
    if (rate === undefined && resolution && inputMode !== 'input_references') {
      const cents = numeric(sku[`cents_per_video_output_second_${resolution}`]);
      if (cents !== undefined) rate = cents / 100;
    }
    if (rate === undefined && inputMode !== 'input_references') {
      rate = numeric(sku.duration_seconds) ?? numeric(sku.cents_per_second_output);
      if (
        rate !== undefined &&
        sku.duration_seconds === undefined &&
        sku.cents_per_second_output !== undefined
      )
        rate /= 100;
    }
    const duration = options.duration;
    if (rate === undefined || duration === undefined)
      return this.unknownVideo(
        model,
        options,
        'O catálogo não publicou uma tarifa por segundo compatível com os parâmetros escolhidos.',
      );
    const referenceInputRate = inputReferenceCount > 0 ? numeric(sku.reference_input_images) : 0;
    if (inputReferenceCount > 0 && referenceInputRate === undefined) {
      return this.unknownVideo(
        model,
        options,
        'O catálogo não informa o custo das imagens de referência para este modelo.',
      );
    }
    if (options.generateAudio && !Object.keys(sku).some((key) => key.toLowerCase().includes('audio'))) {
      return this.unknownVideo(model, options, 'O catálogo não separa eventual custo adicional de áudio.');
    }
    const estimate = (rate * duration + (referenceInputRate ?? 0) * inputReferenceCount) * count;
    return {
      status: 'estimated',
      estimateUsd: Number(estimate.toFixed(6)),
      source: 'OpenRouter video model pricing_skus',
      confidence: 'medium',
      parameters: {
        model: model.id,
        durationSeconds: duration,
        resolution: options.resolution,
        aspectRatio: options.aspectRatio,
        count,
        inputMode,
        frameImageCount,
        inputReferenceCount,
        generateAudio: options.generateAudio ?? false,
        pricePerSecondUsd: rate,
        referenceInputImageUsd: referenceInputRate ?? 0,
      },
      limitations: [
        'frame_images usa a tarifa duration_seconds; input_references usa reference_duration_seconds e reference_input_images quando publicados. O custo final pode diferir.',
      ],
    };
  }

  private unknownVideo(model: VideoModel, options: Record<string, unknown>, reason: string): CostEstimate {
    return {
      status: 'unknown',
      estimateUsd: null,
      source: 'OpenRouter video model pricing_skus',
      confidence: 'none',
      parameters: { model: model.id, ...options },
      limitations: [reason],
    };
  }

  async authorize(
    estimate: CostEstimate,
    args: { allowPaid: boolean; maxCostUsd?: number },
    operation: string,
    fingerprint: string,
  ): Promise<string> {
    if (!args.allowPaid)
      throw new AppError(
        'Operação paga bloqueada. Defina allow_paid: true para autorizar esta geração.',
        'PAYMENT_NOT_AUTHORIZED',
      );
    const requestedLimit = args.maxCostUsd ?? this.config.maxCostPerRequestUsd;
    if (requestedLimit > this.config.maxCostPerRequestUsd) {
      throw new AppError(
        `max_cost_usd não pode exceder o limite global de $${this.config.maxCostPerRequestUsd.toFixed(2)}.`,
        'REQUEST_COST_LIMIT',
      );
    }
    if (estimate.estimateUsd === null) {
      if (!this.config.allowUnknownCost) {
        throw new AppError(
          'O custo não pode ser estimado com os dados atuais. A operação foi bloqueada; configure ALLOW_UNKNOWN_COST=true apenas se aceitar esse risco.',
          'COST_UNKNOWN',
        );
      }
    } else if (estimate.estimateUsd > requestedLimit) {
      throw new AppError(
        `A estimativa de $${estimate.estimateUsd.toFixed(4)} excede o limite por operação de $${requestedLimit.toFixed(2)}.`,
        'REQUEST_COST_LIMIT',
      );
    }
    const id = randomUUID();
    await this.store.reservePaidRequest({
      id,
      operation,
      fingerprint,
      budgetUsd: estimate.estimateUsd ?? 0,
      unknownCost: estimate.estimateUsd === null,
      maxTotalSpendUsd: this.config.maxTotalSpendUsd,
      allowUnknownCost: this.config.allowUnknownCost,
    });
    return id;
  }
}
