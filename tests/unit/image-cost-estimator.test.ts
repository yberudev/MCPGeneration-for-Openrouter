import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { CostGuard } from '../../src/services/cost-guard.js';
import type { ImageModel, OpenRouterModelDetails } from '../../src/types/openrouter.js';
import type { MetadataStore } from '../../src/services/metadata-store.js';

const catalog = JSON.parse(
  readFileSync(new URL('../fixtures/openrouter-image-pricing.json', import.meta.url), 'utf8'),
) as {
  geminiLite: {
    model: ImageModel;
    endpointPricing: unknown[];
    modelDetails: OpenRouterModelDetails;
    documentedOutputImageTokens1K: number;
  };
  flux3: { model: ImageModel; endpointPricing: unknown[] };
};

function costGuard(allowUnknown = false): CostGuard {
  return new CostGuard(
    loadConfig({
      ALLOW_UNKNOWN_COST: String(allowUnknown),
      MAX_COST_PER_REQUEST_USD: '1',
      MAX_TOTAL_SPEND_USD: '2',
    }),
    {} as MetadataStore,
  );
}

describe('image cost estimates from OpenRouter catalog snapshots', () => {
  it('computes a documented 1K Gemini upper bound from current token tariffs and model limits', () => {
    const estimate = costGuard().imageEstimate(
      catalog.geminiLite.model,
      catalog.geminiLite.endpointPricing.flatMap((endpoint) => (endpoint as { pricing: unknown[] }).pricing),
      1,
      'generate',
      { resolution: '1K', aspectRatio: '4:5', modelDetails: catalog.geminiLite.modelDetails },
    );

    expect(estimate).toMatchObject({
      status: 'estimated',
      kind: 'defensible_upper_bound',
      estimateUsd: 0.138457,
      confidence: 'high',
    });
    expect(estimate.sourceDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(estimate.parameters).toMatchObject({
      inputTokenPriceUsd: 0.00000025,
      textOutputTokenPriceUsd: 0.0000015,
      imageOutputTokenPriceUsd: 0.00003,
      inputContextTokenLimit: 65536,
      maxCompletionTokens: 58982,
      imageOutputTokens: catalog.geminiLite.documentedOutputImageTokens1K,
      referencesWithinInputContextCeiling: true,
    });
    expect(estimate.assumptions?.length).toBeGreaterThanOrEqual(4);
    expect(costGuard().validate(estimate, { allowPaid: true, maxCostUsd: 1 })).toBeUndefined();
  });

  it('multiplies Gemini upper bounds by variation count and accounts for reference input within context', () => {
    const estimate = costGuard().imageEstimate(
      catalog.geminiLite.model,
      catalog.geminiLite.endpointPricing.flatMap((endpoint) => (endpoint as { pricing: unknown[] }).pricing),
      2,
      'variation',
      { resolution: '1K', referenceCount: 14, modelDetails: catalog.geminiLite.modelDetails },
    );
    expect(estimate.estimateUsd).toBe(0.276914);
    expect(estimate.parameters.referenceCount).toBe(14);
    expect(estimate.assumptions?.join(' ')).toContain('imagens de referência');
  });

  it('keeps ALLOW_UNKNOWN_COST=false: a grounded estimate passes while missing limits block', () => {
    const guard = costGuard(false);
    const unknown = guard.imageEstimate(
      catalog.geminiLite.model,
      catalog.geminiLite.endpointPricing,
      1,
      'generate',
      { resolution: '1K' },
    );
    expect(unknown).toMatchObject({ status: 'unknown', kind: 'unknown', estimateUsd: null });
    expect(() => guard.validate(unknown, { allowPaid: true })).toThrow(
      expect.objectContaining({ code: 'COST_UNKNOWN' }),
    );
    const unknownOverride = costGuard(true);
    expect(() => unknownOverride.validate(unknown, { allowPaid: true })).not.toThrow();
  });

  it.each([
    ['768', 0.041],
    ['1K', 0.048],
    ['1.5K', 0.07],
    ['2K', 0.1],
    ['4K', 0.607],
  ])('selects the OpenRouter FLUX 3 tariff for %s and scales variation count', (resolution, price) => {
    const pricing = catalog.flux3.endpointPricing.flatMap(
      (endpoint) => (endpoint as { pricing: unknown[] }).pricing,
    );
    const estimate = costGuard().imageEstimate(catalog.flux3.model, pricing, 2, 'variation', {
      resolution,
      aspectRatio: '4:5',
      referenceCount: 1,
    });
    expect(estimate).toMatchObject({
      status: 'estimated',
      kind: 'fixed_price',
      estimateUsd: price * 2,
      confidence: 'high',
    });
  });

  it('uses the highest published FLUX tier when resolution is omitted and does not pick the first price', () => {
    const pricing = catalog.flux3.endpointPricing.flatMap(
      (endpoint) => (endpoint as { pricing: unknown[] }).pricing,
    );
    const estimate = costGuard().imageEstimate(catalog.flux3.model, pricing, 1, 'generate');
    expect(estimate).toMatchObject({
      kind: 'defensible_upper_bound',
      estimateUsd: 0.607,
      parameters: { unitPriceUsd: 0.607 },
    });
  });

  it('uses the higher published price when providers disagree on the same FLUX variant', () => {
    const pricing = catalog.flux3.endpointPricing.flatMap(
      (endpoint) => (endpoint as { pricing: unknown[] }).pricing,
    );
    pricing.push({ billable: 'output_image', unit: 'image', cost_usd: 0.12, variant: '2k' });
    const estimate = costGuard().imageEstimate(catalog.flux3.model, pricing, 2, 'edit', {
      resolution: '2K',
      referenceCount: 1,
    });
    expect(estimate).toMatchObject({
      kind: 'defensible_upper_bound',
      estimateUsd: 0.24,
      parameters: { unitPriceUsd: 0.12 },
    });
  });

  it('returns unknown for a resolution absent from the live endpoint table', () => {
    const pricing = catalog.flux3.endpointPricing.flatMap(
      (endpoint) => (endpoint as { pricing: unknown[] }).pricing,
    );
    const estimate = costGuard().imageEstimate(catalog.flux3.model, pricing, 1, 'edit', {
      resolution: '8K',
      referenceCount: 10,
    });
    expect(estimate).toMatchObject({ status: 'unknown', estimateUsd: null });
  });

  it('includes explicit generic input-image tariffs and blocks references without a published input tariff', () => {
    const model = { id: 'example/image-model' } as ImageModel;
    const outputOnly = [{ billable: 'output_image', unit: 'image', cost_usd: 0.05 }];
    expect(
      costGuard().imageEstimate(model, outputOnly, 1, 'edit', { referenceCount: 1 }),
    ).toMatchObject({ status: 'unknown', estimateUsd: null });

    const estimate = costGuard().imageEstimate(
      model,
      [...outputOnly, { billable: 'input_image', unit: 'image', cost_usd: 0.002 }],
      2,
      'variation',
      { referenceCount: 3 },
    );
    expect(estimate).toMatchObject({
      status: 'estimated',
      kind: 'defensible_upper_bound',
      estimateUsd: 0.106,
      parameters: {
        operation: 'variation',
        count: 2,
        referenceCount: 3,
        inputReferenceUnitPriceUsd: 0.002,
        referenceUpperBoundUsd: 0.006,
      },
    });
  });

  it('rejects invalid output or reference quantities as unknown', () => {
    const model = catalog.flux3.model;
    const pricing = catalog.flux3.endpointPricing.flatMap(
      (endpoint) => (endpoint as { pricing: unknown[] }).pricing,
    );
    expect(costGuard().imageEstimate(model, pricing, 0, 'generate')).toMatchObject({
      status: 'unknown',
      estimateUsd: null,
    });
    expect(costGuard().imageEstimate(model, pricing, 1, 'edit', { referenceCount: -1 })).toMatchObject({
      status: 'unknown',
      estimateUsd: null,
    });
  });
});
