import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import type { ImageModel, OpenRouterModelDetails, VideoModel } from '../types/openrouter.js';
import type { MetadataStore } from './metadata-store.js';
import { videoAudioCapability } from './video-capabilities.js';

export interface CostEstimate {
  status: 'estimated' | 'unknown';
  kind?: 'fixed_price' | 'grounded_estimate' | 'defensible_upper_bound' | 'unknown';
  estimateUsd: number | null;
  source: string;
  sourceDate?: string;
  confidence: 'high' | 'medium' | 'none';
  parameters: Record<string, unknown>;
  assumptions?: string[];
  limitations: string[];
}

export interface ImageEstimateOptions {
  resolution?: string;
  aspectRatio?: string;
  referenceCount?: number;
  modelDetails?: OpenRouterModelDetails;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim() === '') return undefined;
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
    options: ImageEstimateOptions = {},
  ): CostEstimate {
    const entries = Array.isArray(pricing)
      ? pricing.filter(
          (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object',
        )
      : [];
    const sourceDate = new Date().toISOString();
    const referenceCount = options.referenceCount ?? 0;
    const parameters = {
      model: model.id,
      operation,
      resolution: options.resolution,
      aspectRatio: options.aspectRatio,
      count,
      referenceCount,
    };
    if (!Number.isInteger(count) || count < 1 || !Number.isInteger(referenceCount) || referenceCount < 0)
      return this.unknownImage(parameters, sourceDate, ['A quantidade de saídas ou referências não é válida para uma estimativa.']);

    if (model.id === 'google/gemini-3.1-flash-lite-image') {
      const details = options.modelDetails;
      const modelPricing = details?.pricing ?? {};
      const inputRate = numeric(modelPricing.prompt);
      const textOutputRate = numeric(modelPricing.completion);
      const contextTokens = numeric(details?.context_length);
      const maxOutputTokens = numeric(details?.top_provider?.max_completion_tokens);
      const imageTokenPrices = entries
        .filter((item) => item.billable === 'output_image' && item.unit === 'token')
        .map((item) => numeric(item.cost_usd))
        .filter((value): value is number => value !== undefined);
      const imageOutputRate = imageTokenPrices.length ? Math.max(...imageTokenPrices) : numeric(modelPricing.image_output);
      const modelResolutions = this.supportedValues(model, 'resolution');
      const resolution = options.resolution ?? (modelResolutions.length === 1 ? modelResolutions[0] : undefined);
      const referenceMax = this.supportedMaximum(model, 'input_references');
      if (
        inputRate !== undefined &&
        textOutputRate !== undefined &&
        contextTokens !== undefined &&
        maxOutputTokens !== undefined &&
        imageOutputRate !== undefined &&
        resolution === '1K' &&
        count >= 1 &&
        Number.isInteger(count) &&
        (options.referenceCount ?? 0) >= 0 &&
        (options.referenceCount ?? 0) <= referenceMax
      ) {
        // Google prices a 1K image from this exact model at 1,120 image tokens. It publishes no
        // separate per-aspect-ratio 1K rate, so use that documented 1K charge for accepted ratios.
        // Reserve the full current input/completion ceilings plus the fixed image output tokens.
        const imageOutputTokens = 1_120;
        const inputUpperBoundUsd = contextTokens * inputRate;
        const textOutputUpperBoundUsd = maxOutputTokens * textOutputRate;
        const imageOutputUsd = imageOutputTokens * imageOutputRate;
        const perImageUpperBound = inputUpperBoundUsd + textOutputUpperBoundUsd + imageOutputUsd;
        return {
          status: 'estimated',
          kind: 'defensible_upper_bound',
          estimateUsd: Number((perImageUpperBound * count).toFixed(8)),
          source:
            'OpenRouter model catalog /api/v1/models + image endpoint pricing; Google Gemini 3.1 Flash Lite Image pricing and image-generation token table',
          sourceDate,
          confidence: 'high',
          parameters: {
            ...parameters,
            inputTokenPriceUsd: inputRate,
            textOutputTokenPriceUsd: textOutputRate,
            imageOutputTokenPriceUsd: imageOutputRate,
            inputContextTokenLimit: contextTokens,
            maxCompletionTokens: maxOutputTokens,
            imageOutputTokens,
            inputUpperBoundUsd,
            textOutputUpperBoundUsd,
            imageOutputUsd,
            perImageUpperBoundUsd: Number(perImageUpperBound.toFixed(8)),
            referencesWithinInputContextCeiling: true,
          },
          assumptions: [
            'Cada resposta gera no máximo uma imagem 1K; o catálogo de imagens publica n.max=1.',
            'A imagem de saída custa 1.120 tokens em 1K; a tarifa por token é a atual do endpoint OpenRouter.',
            'O teto de entrada usa todo o context_length publicado e inclui prompt e imagens de referência.',
            'O teto de texto/razão usa top_provider.max_completion_tokens e a tarifa completion do catálogo OpenRouter; os tokens de imagem são somados separadamente para manter a reserva conservadora.',
            'Google publica uma tarifa por imagem 1K sem tabela distinta por proporção; a estimativa aplica essa tarifa às proporções aceites pelo catálogo. Edições contam referências no teto de entrada.',
          ],
          limitations: [
            'Limite superior calculado a partir dos limites e tarifas publicados na data indicada; alterações de preço/modelo ou uma cobrança diferente do catálogo podem excedê-lo.',
            'max_cost_usd autoriza localmente o pedido e não impõe um teto absoluto de cobrança ao fornecedor.',
          ],
        };
      }
      return this.unknownImage(parameters, sourceDate, [
        'Faltam dados atuais verificáveis de preço, resolução 1K, context_length, max_completion_tokens ou número de referências para calcular um limite superior do Gemini.',
      ]);
    }

    const outputImageEntries = entries.filter(
      (item) => item.billable === 'output_image' && item.unit === 'image' && numeric(item.cost_usd) !== undefined,
    );
    const inputImageEntries = entries.filter(
      (item) => item.billable === 'input_image' && item.unit === 'image' && numeric(item.cost_usd) !== undefined,
    );
    const requestedVariant = resolutionToken(options.resolution);
    const selected = requestedVariant
      ? outputImageEntries.filter((item) => resolutionToken(String(item.variant ?? '')) === requestedVariant)
      : outputImageEntries;
    if (outputImageEntries.length && selected.length) {
      const fluxReferencesIncluded = model.id === 'black-forest-labs/flux-3-image';
      if (referenceCount > 0 && !fluxReferencesIncluded && inputImageEntries.length === 0) {
        return this.unknownImage(parameters, sourceDate, [
          'O catálogo não informa se as imagens de referência desta operação têm uma tarifa adicional nem publica uma tarifa de entrada verificável.',
        ]);
      }
      const uniquePrices = selected
        .map((item) => numeric(item.cost_usd)!)
        .filter((price, index, all) => all.indexOf(price) === index);
      const price = Math.max(...uniquePrices);
      const inputReferencePrice = referenceCount > 0 && !fluxReferencesIncluded
        ? Math.max(...inputImageEntries.map((item) => numeric(item.cost_usd)!))
        : 0;
      const referenceUpperBoundUsd = inputReferencePrice * referenceCount;
      const unresolvedResolution = !options.resolution && outputImageEntries.some((item) => item.variant !== undefined);
      const multipleProviderPrices = uniquePrices.length > 1;
      const kind = unresolvedResolution || multipleProviderPrices ? 'defensible_upper_bound' : 'fixed_price';
      const billableUnitCount = count;
      const totalEstimateUsd = price * billableUnitCount + referenceUpperBoundUsd;
      return {
        status: 'estimated',
        kind: inputReferencePrice > 0 ? 'defensible_upper_bound' : kind,
        estimateUsd: Number(totalEstimateUsd.toFixed(8)),
        source: 'OpenRouter image endpoint pricing (billable output_image)',
        sourceDate,
        confidence: 'high',
        parameters: {
          ...parameters,
          unitPriceUsd: price,
          billableUnit: 'output_image',
          pricedVariants: selected.map((item) => item.variant ?? null),
          referenceInputs: referenceCount,
          inputReferenceUnitPriceUsd: inputReferencePrice,
          referenceUpperBoundUsd,
          referencePriceMultiplier: referenceCount,
          referencesPricedConservativelyPerOutput: referenceCount > 0 && !fluxReferencesIncluded,
        },
        assumptions: [
          'A quantidade representa o total de imagens de saída; variações submetidas como chamadas separadas multiplicam a tarifa.',
          ...(model.id === 'black-forest-labs/flux-3-image'
            ? [
                'A tabela OpenRouter diferencia as cinco resoluções. A tabela oficial BFL informa o mesmo preço por imagem para texto/imagem para imagem e sem custo adicional por referências.',
              ]
            : []),
          ...(inputReferencePrice > 0
            ? ['A tarifa publicada para cada imagem de referência é multiplicada pelo número de referências; a reserva usa essa tarifa em cada saída como limite superior.']
            : []),
          ...(unresolvedResolution
            ? ['Sem resolução explícita, usa-se a maior tarifa publicada para limitar a autorização.']
            : []),
          ...(multipleProviderPrices
            ? ['Há tarifas diferentes para a mesma seleção; usa-se a maior tarifa dos endpoints disponíveis.']
            : []),
        ],
        limitations: [
          'A autorização usa os preços publicados atualmente pelo OpenRouter; o custo debitado pelo fornecedor pode diferir.',
          'max_cost_usd é um controlo local de autorização, não um teto absoluto de cobrança do fornecedor.',
        ],
      };
    }

    return this.unknownImage(parameters, sourceDate, [
      options.resolution
        ? `O catálogo OpenRouter não publicou um preço por imagem para resolução ${options.resolution}.`
        : 'O catálogo OpenRouter não publicou um preço fixo por imagem compatível com esta operação e unidade.',
    ]);
  }

  private supportedValues(model: ImageModel, key: string): string[] {
    const rule = model.supported_parameters?.[key];
    if (!rule || typeof rule !== 'object' || !('values' in rule) || !Array.isArray(rule.values)) return [];
    return rule.values.filter((value): value is string => typeof value === 'string');
  }

  private supportedMaximum(model: ImageModel, key: string): number {
    const rule = model.supported_parameters?.[key];
    if (!rule || typeof rule !== 'object' || !('max' in rule)) return 0;
    return numeric(rule.max) ?? 0;
  }

  private unknownImage(parameters: Record<string, unknown>, sourceDate: string, limitations: string[]): CostEstimate {
    return {
      status: 'unknown',
      kind: 'unknown',
      estimateUsd: null,
      source: 'OpenRouter image model and endpoint catalogs',
      sourceDate,
      confidence: 'none',
      parameters,
      assumptions: [],
      limitations,
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
    if (
      options.generateAudio &&
      videoAudioCapability(model).mode === 'configurable' &&
      !Object.keys(sku).some((key) => key.toLowerCase().includes('audio'))
    ) {
      return this.unknownVideo(model, options, 'O catálogo não separa eventual custo adicional de áudio.');
    }
    const estimate = (rate * duration + (referenceInputRate ?? 0) * inputReferenceCount) * count;
    return {
      status: 'estimated',
      kind: 'grounded_estimate',
      estimateUsd: Number(estimate.toFixed(6)),
      source: 'OpenRouter video model pricing_skus',
      sourceDate: new Date().toISOString(),
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
        generateAudio: options.generateAudio ?? null,
        pricePerSecondUsd: rate,
        referenceInputImageUsd: referenceInputRate ?? 0,
      },
      assumptions: ['A estimativa utiliza a tarifa SKU e os parâmetros públicos do modelo.'],
      limitations: [
        'frame_images usa a tarifa duration_seconds; input_references usa reference_duration_seconds e reference_input_images quando publicados. O custo final pode diferir.',
      ],
    };
  }

  private unknownVideo(model: VideoModel, options: Record<string, unknown>, reason: string): CostEstimate {
    return {
      status: 'unknown',
      kind: 'unknown',
      estimateUsd: null,
      source: 'OpenRouter video model pricing_skus',
      sourceDate: new Date().toISOString(),
      confidence: 'none',
      parameters: { model: model.id, ...options },
      assumptions: [],
      limitations: [reason],
    };
  }

  async authorize(
    estimate: CostEstimate,
    args: { allowPaid: boolean; maxCostUsd?: number },
    operation: string,
    fingerprint: string,
    requestId: string = randomUUID(),
  ): Promise<string> {
    this.validate(estimate, args);
    await this.store.reservePaidRequest({
      id: requestId,
      operation,
      fingerprint,
      budgetUsd: estimate.estimateUsd ?? 0,
      unknownCost: estimate.estimateUsd === null,
      maxTotalSpendUsd: this.config.maxTotalSpendUsd,
      allowUnknownCost: this.config.allowUnknownCost,
    });
    return requestId;
  }

  validate(estimate: CostEstimate, args: { allowPaid: boolean; maxCostUsd?: number }): void {
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
          'O custo não pode ser estimado com os dados atuais. A operação foi bloqueada enquanto ALLOW_UNKNOWN_COST=false; obtenha dados de preço atuais antes de tentar novamente.',
          'COST_UNKNOWN',
        );
      }
    } else if (estimate.estimateUsd > requestedLimit) {
      throw new AppError(
        `A estimativa de $${estimate.estimateUsd.toFixed(4)} excede o limite por operação de $${requestedLimit.toFixed(2)}.`,
        'REQUEST_COST_LIMIT',
      );
    }
  }
}
