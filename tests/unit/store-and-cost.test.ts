import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { CostGuard } from '../../src/services/cost-guard.js';
import { JobManager, normalizeVideoStatus } from '../../src/services/job-manager.js';
import { MetadataStore } from '../../src/services/metadata-store.js';

const execFileAsync = promisify(execFile);

describe('video job persistence and cost guard', () => {
  it('normalizes and recovers task states from persistent JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-data-'));
    const first = new MetadataStore(dir);
    await first.init();
    const manager = new JobManager(first);
    const job = await manager.create({
      remote: { id: 'remote-1', status: 'in_progress' },
      model: 'heygen/heygen-video-1',
      prompt: 'a fox',
      config: { duration: 5 },
    });
    expect(job.status).toBe('in_progress');
    const second = new MetadataStore(dir);
    expect((await second.getJob(job.id))?.remoteId).toBe('remote-1');
    expect(normalizeVideoStatus('completed')).toBe('completed');
    expect(normalizeVideoStatus('expired')).toBe('expired');
  });

  it('estimates published HeyGen duration pricing and enforces explicit payment approval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-data-'));
    const store = new MetadataStore(dir);
    await store.init();
    const guard = new CostGuard(loadConfig({ YBERU_DATA_DIR: dir }), store);
    const model = {
      id: 'heygen/heygen-video-1',
      pricing_skus: {
        duration_seconds_480p: '0.02',
        reference_duration_seconds_480p: '0.07',
        reference_input_images: '0.04',
      },
    };
    const textEstimate = guard.videoEstimate(model, { duration: 5, resolution: '480p' });
    const frameEstimate = guard.videoEstimate(model, {
      duration: 5,
      resolution: '480p',
      frameImageCount: 1,
    });
    const referenceEstimate = guard.videoEstimate(model, {
      duration: 5,
      resolution: '480p',
      inputReferenceCount: 1,
    });
    expect(textEstimate.estimateUsd).toBe(0.1);
    expect(frameEstimate.estimateUsd).toBe(0.1);
    expect(referenceEstimate.estimateUsd).toBe(0.39);
    expect(frameEstimate.parameters.inputMode).toBe('frame_images');
    expect(referenceEstimate.parameters.inputMode).toBe('input_references');
    await expect(
      guard.authorize(textEstimate, { allowPaid: false }, 'generate_video', 'no-pay'),
    ).rejects.toThrow('allow_paid');
    const id = await guard.authorize(textEstimate, { allowPaid: true }, 'generate_video', 'pay');
    expect(id).toBeTruthy();
    await store.releasePaidRequest(id);
  });

  it('blocks unknown costs unless an explicit operator policy is enabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-data-'));
    const store = new MetadataStore(dir);
    await store.init();
    const guard = new CostGuard(loadConfig({ YBERU_DATA_DIR: dir }), store);
    const estimate = {
      status: 'unknown' as const,
      estimateUsd: null,
      source: 'catalog',
      confidence: 'none' as const,
      parameters: {},
      limitations: [],
    };
    await expect(
      guard.authorize(estimate, { allowPaid: true }, 'generate_image', 'unknown'),
    ).rejects.toMatchObject({ code: 'COST_UNKNOWN' });
    const override = new CostGuard(loadConfig({ YBERU_DATA_DIR: dir, ALLOW_UNKNOWN_COST: 'true' }), store);
    const id = await override.authorize(estimate, { allowPaid: true }, 'generate_image', 'unknown');
    await expect(
      override.authorize(
        { ...estimate, estimateUsd: 0.01, status: 'estimated' },
        { allowPaid: true },
        'generate_image',
        'other',
      ),
    ).rejects.toMatchObject({ code: 'UNKNOWN_SPEND_REQUIRES_RECONCILIATION' });
    await store.releasePaidRequest(id);
  });

  it('reserves concurrent spend and blocks duplicate uncertain submissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-data-'));
    const store = new MetadataStore(dir);
    await store.init();
    const config = loadConfig({
      YBERU_DATA_DIR: dir,
      MAX_TOTAL_SPEND_USD: '1',
      MAX_COST_PER_REQUEST_USD: '1',
    });
    const guard = new CostGuard(config, store);
    const estimate = {
      status: 'estimated' as const,
      estimateUsd: 0.75,
      source: 'catalog',
      confidence: 'high' as const,
      parameters: {},
      limitations: [],
    };
    const id = await guard.authorize(estimate, { allowPaid: true }, 'generate_video', 'same-request');
    await expect(
      guard.authorize(estimate, { allowPaid: true }, 'generate_video', 'same-request'),
    ).rejects.toMatchObject({ code: 'DUPLICATE_UNCERTAIN_REQUEST' });
    await expect(
      guard.authorize(estimate, { allowPaid: true }, 'generate_video', 'different-request'),
    ).rejects.toMatchObject({ code: 'TOTAL_SPEND_LIMIT' });
    await store.markPaidRequestUncertain(id, {
      model: 'mock/video',
      estimateUsd: 0.75,
      operation: 'uncertain',
    });
    await expect(
      guard.authorize(estimate, { allowPaid: true }, 'generate_video', 'same-request'),
    ).rejects.toMatchObject({ code: 'DUPLICATE_UNCERTAIN_REQUEST' });
  });

  it('refreshes an existing pre-POST reservation atomically when the live estimate changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-refresh-reservation-'));
    const store = new MetadataStore(dir);
    await store.init();
    const config = loadConfig({
      YBERU_DATA_DIR: dir,
      MAX_TOTAL_SPEND_USD: '1',
      MAX_COST_PER_REQUEST_USD: '1',
    });
    const guard = new CostGuard(config, store);
    const first = {
      status: 'estimated' as const,
      kind: 'grounded_estimate' as const,
      estimateUsd: 0.25,
      source: 'old catalog snapshot',
      confidence: 'high' as const,
      parameters: {},
      limitations: [],
    };
    const refreshed = { ...first, estimateUsd: 0.75, source: 'current catalog snapshot' };
    const id = await guard.authorize(first, { allowPaid: true }, 'generate_image', 'same-job', 'stable-id');
    await guard.authorize(refreshed, { allowPaid: true }, 'generate_image', 'same-job', id);
    expect((await store.paidRequest(id))?.budgetUsd).toBe(0.75);
    expect(await store.totalSpendUsd()).toBe(0.75);
    await expect(
      guard.authorize({ ...refreshed, estimateUsd: 1.01 }, { allowPaid: true }, 'generate_image', 'same-job', id),
    ).rejects.toMatchObject({ code: 'REQUEST_COST_LIMIT' });
    expect((await store.paidRequest(id))?.budgetUsd).toBe(0.75);
  });

  it('serializes budget reservations across separate Node.js processes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-cross-process-budget-'));
    const childScript = resolve('tests/fixtures/reserve-spend-child.ts');
    const runChild = (fingerprint: string) =>
      execFileAsync(process.execPath, ['--import', 'tsx', childScript, dir, fingerprint], {
        cwd: process.cwd(),
        timeout: 20_000,
      });
    const results = await Promise.all([runChild('process-a'), runChild('process-b')]);
    const outcomes = results.map(({ stdout }) => stdout.trim()).sort();
    expect(outcomes).toEqual(['TOTAL_SPEND_LIMIT', 'reserved']);
    const store = new MetadataStore(dir);
    expect(await store.totalSpendUsd()).toBe(0.75);
  }, 30_000);
});
