import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { OpenRouterClient } from '../../src/providers/openrouter/client.js';
import { AssetManager } from '../../src/services/asset-manager.js';
import { CostGuard } from '../../src/services/cost-guard.js';
import { ImageJobQueue, type ImageJobPayload } from '../../src/services/image-job-queue.js';
import { ImageJobWorker } from '../../src/services/image-job-worker.js';
import { MetadataStore } from '../../src/services/metadata-store.js';
import type { OpenRouterImageRequest } from '../../src/types/openrouter.js';
import type { ModelRegistry } from '../../src/services/model-registry.js';

function pngBase64(): string {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(32, 16);
  png.writeUInt32BE(32, 20);
  return png.toString('base64');
}

function imageResponse(cost: number | undefined = 0.04): Response {
  return responseWithData([{ b64_json: pngBase64(), media_type: 'image/png' }], cost);
}

function responseWithData(data: unknown, cost: number | undefined = 0.04): Response {
  return Response.json({
    data,
    ...(cost === undefined ? {} : { usage: { cost } }),
  });
}

function webpBase64(): string {
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'ascii');
  webp.writeUInt32LE(22, 4);
  webp.write('WEBP', 8, 'ascii');
  webp.write('VP8X', 12, 'ascii');
  return webp.toString('base64');
}

function jpegBase64(): string {
  const jpeg = Buffer.alloc(15);
  jpeg[0] = 0xff;
  jpeg[1] = 0xd8;
  jpeg[2] = 0xff;
  jpeg[3] = 0xc0;
  jpeg.writeUInt16BE(11, 4);
  jpeg[6] = 8;
  jpeg.writeUInt16BE(1, 7);
  jpeg.writeUInt16BE(1, 9);
  return jpeg.toString('base64');
}

async function fixture(
  fetchImpl?: typeof fetch,
  maxHttpResponseBytes = 160_000_000,
  enqueue = true,
  maxCostPerRequestUsd = 5,
) {
  const temp = await mkdtemp(join(tmpdir(), 'mcp-image-worker-'));
  const root = join(temp, 'project');
  const dataDir = join(temp, 'state');
  const config = loadConfig({
    OPENROUTER_API_KEY: 'test-secret-never-log',
    YBERU_PROJECT_ROOT: root,
    YBERU_DATA_DIR: dataDir,
    MAX_COST_PER_REQUEST_USD: String(maxCostPerRequestUsd),
    MAX_TOTAL_SPEND_USD: '20',
    MAX_HTTP_RESPONSE_BYTES: String(maxHttpResponseBytes),
  });
  await (await import('node:fs/promises')).mkdir(root, { recursive: true });
  const store = new MetadataStore(dataDir);
  await store.init();
  const adapterQueue = new ImageJobQueue(dataDir);
  await adapterQueue.init();
  const workerQueue = new ImageJobQueue(dataDir);
  await workerQueue.init();
  const fetchMock: typeof fetch = fetchImpl ?? (async () => imageResponse());
  const client = new OpenRouterClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.httpTimeoutMs,
    maxResponseBytes: config.maxHttpResponseBytes,
    fetchImpl: fetchMock,
  });
  const costs = new CostGuard(config, store);
  const assets = new AssetManager(config, store);
  const body: OpenRouterImageRequest = { model: 'google/gemini-3.1-flash-lite-image', prompt: 'test image' };
  const payload: ImageJobPayload = {
    operation: 'generate_image',
    model: body.model,
    prompt: body.prompt,
    requestBodies: [body],
    outputRoot: root,
    resolvedOutputDir: join(root, 'public', 'assets', 'generated', 'images'),
    estimateUsd: 0.05,
    estimateSource: 'mock catalog',
    estimateUnknownCost: false,
    maxCostUsd: maxCostPerRequestUsd,
    maxCostPerRequestUsd,
    maxTotalSpendUsd: 20,
    allowUnknownCost: false,
    expectedOutputCount: 1,
  };
  const queued = enqueue ? adapterQueue.enqueue(payload, body) : undefined;
  const logs: Array<Record<string, unknown>> = [];
  const worker = new ImageJobWorker({
    config,
    client,
    assets,
    costs,
    store,
    queue: workerQueue,
    logger: (entry) => logs.push(entry),
  });
  return {
    temp,
    root,
    dataDir,
    config,
    store,
    adapterQueue,
    workerQueue,
    client,
    costs,
    assets,
    payload,
    body,
    jobId: queued?.job.id ?? '',
    worker,
    logs,
    async close() {
      worker.requestStop();
      for (const queue of [adapterQueue, workerQueue]) {
        try {
          queue.close();
        } catch {
          /* May already be closed by a simulated adapter exit. */
        }
      }
      await rm(temp, { recursive: true, force: true });
    },
  };
}

describe('durable image jobs and worker recovery', () => {
  it('deduplicates concurrent adapter submissions through two SQLite connections', async () => {
    const f = await fixture();
    try {
      const second = f.workerQueue.enqueue(f.payload, f.body);
      expect(second.duplicate).toBe(true);
      expect(second.job.id).toBe(f.jobId);
      expect(f.workerQueue.list()).toHaveLength(1);
      expect(f.workerQueue.get(f.jobId)?.status).toBe('queued');
    } finally {
      await f.close();
    }
  });

  it('continues after the stdio database handle closes during a simulated 150 second POST', async () => {
    let releaseResponse!: () => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const f = await fixture(async (_input, init) => {
      if (init?.method !== 'POST') throw new Error('Unexpected method');
      notifyStarted();
      await gate;
      return imageResponse();
    });
    try {
      const run = f.worker.runOne();
      await started;
      expect(f.workerQueue.get(f.jobId)?.phase).toBe('post_started');
      f.adapterQueue.close(); // Equivalent to the Claude stdio process exiting.
      releaseResponse();
      await run;
      const job = f.workerQueue.get(f.jobId);
      expect(job?.status).toBe('completed');
      expect(job?.files).toHaveLength(1);
      expect((await readFile(job!.files[0]!)).length).toBe(24);
    } finally {
      releaseResponse();
      await f.close();
    }
  });

  it('finishes a simulated 150 second job after the separate adapter process is terminated', async () => {
    let releaseResponse!: () => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const f = await fixture(
      async (_input, init) => {
        if (init?.method !== 'POST') throw new Error('Unexpected method');
        notifyStarted();
        await gate;
        return imageResponse();
      },
      160_000_000,
      false,
    );
    let child: ReturnType<typeof spawn> | undefined;
    let run: Promise<boolean> | undefined;
    try {
      child = spawn(
        process.execPath,
        ['--import', 'tsx', 'tests/fixtures/queue-client-child.ts', f.dataDir, f.root],
        {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, NODE_NO_WARNINGS: '1' },
        },
      );
      const lines = createInterface({ input: child.stdout! });
      const childJobId = await new Promise<string>((resolve, reject) => {
        child!.once('error', reject);
        lines.once('line', (line) => resolve((JSON.parse(line) as { jobId: string }).jobId));
      });
      expect(childJobId).toMatch(/^[0-9a-f-]{36}$/);
      run = f.worker.runOne();
      await started;
      child.kill('SIGTERM');
      await new Promise<void>((resolve, reject) => {
        child!.once('error', reject);
        child!.once('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`child exited with ${code}`)),
        );
      });
      f.adapterQueue.close();
      releaseResponse();
      await run;
      const job = f.workerQueue.get(childJobId);
      expect(job?.status).toBe('completed');
      expect(job?.files).toHaveLength(1);
      expect((await readFile(job!.files[0]!)).length).toBe(24);
    } finally {
      releaseResponse();
      if (child && child.exitCode === null) child.kill('SIGTERM');
      await run?.catch(() => undefined);
      await f.close();
    }
  });

  it('recovers a worker restart before POST without duplicating the reservation', async () => {
    let posts = 0;
    const f = await fixture(async (_input, init) => {
      if (init?.method === 'POST') posts += 1;
      return imageResponse();
    });
    try {
      f.adapterQueue.claimNext();
      await f.costs.authorize(
        {
          status: 'estimated',
          estimateUsd: 0.05,
          source: 'test',
          confidence: 'high',
          parameters: {},
          limitations: [],
        },
        { allowPaid: true },
        'generate_image',
        f.workerQueue.get(f.jobId)!.fingerprint,
        f.jobId,
      );
      f.adapterQueue.setPhase(f.jobId, 'budget_reserved', 'not_started', 'reserved');
      f.adapterQueue.close();
      await f.worker.recover();
      expect(f.workerQueue.get(f.jobId)?.status).toBe('queued');
      await f.worker.runOne();
      expect(posts).toBe(1);
      expect(f.workerQueue.get(f.jobId)?.status).toBe('completed');
      expect(await f.store.paidRequest(f.jobId)).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it('marks a restart after possible POST as uncertain and never resends it', async () => {
    let posts = 0;
    const f = await fixture(async (_input, init) => {
      if (init?.method === 'POST') posts += 1;
      return imageResponse();
    });
    try {
      f.adapterQueue.claimNext();
      await f.costs.authorize(
        {
          status: 'estimated',
          estimateUsd: 0.05,
          source: 'test',
          confidence: 'high',
          parameters: {},
          limitations: [],
        },
        { allowPaid: true },
        'generate_image',
        f.workerQueue.get(f.jobId)!.fingerprint,
        f.jobId,
      );
      f.adapterQueue.setPhase(f.jobId, 'budget_reserved', 'not_started', 'reserved');
      f.adapterQueue.markCallPostStarted(f.jobId, 0);
      f.adapterQueue.close();
      await f.worker.recover();
      expect(f.workerQueue.get(f.jobId)?.status).toBe('uncertain');
      expect((await f.store.paidRequest(f.jobId))?.state).toBe('uncertain');
      expect(await f.worker.runOne()).toBe(false);
      expect(posts).toBe(0);
    } finally {
      await f.close();
    }
  });

  it('releases a reservation on definitive HTTP 400 and records no fake usage', async () => {
    let posts = 0;
    const f = await fixture(async (_input, init) => {
      if (init?.method === 'POST') {
        posts += 1;
        return Response.json({ error: 'bad request' }, { status: 400 });
      }
      return imageResponse();
    });
    try {
      await f.worker.runOne();
      expect(posts).toBe(1);
      expect(f.workerQueue.get(f.jobId)?.status).toBe('failed');
      expect(await f.store.paidRequests()).toEqual([]);
      expect(await f.store.usageForJob(f.jobId)).toBeUndefined();
      expect(await f.worker.runOne()).toBe(false);
      expect(posts).toBe(1);
    } finally {
      await f.close();
    }
  });

  it.each([
    ['HTTP 5xx', async () => Response.json({ error: 'upstream failure' }, { status: 503 })],
    [
      'HTTP timeout',
      async () => {
        throw new DOMException('request timed out', 'TimeoutError');
      },
    ],
    [
      'ECONNRESET',
      async () => {
        throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      },
    ],
    ['resposta demasiado grande', async () => new Response('x'.repeat(200), { status: 200 })],
  ])('%s fica incerto e não recebe retry', async (_label, postResponse) => {
    let posts = 0;
    const f = await fixture(async (_input, init) => {
      if (init?.method === 'POST') {
        posts += 1;
        return postResponse();
      }
      return imageResponse();
    }, 64);
    try {
      await f.worker.runOne();
      expect(f.workerQueue.get(f.jobId)?.status).toBe('uncertain');
      expect((await f.store.paidRequest(f.jobId))?.state).toBe('uncertain');
      expect(await f.worker.runOne()).toBe(false);
      expect(posts).toBe(1);
    } finally {
      await f.close();
    }
  });

  it('preserves a valid HTTP 200 body before parsing and clears only the body after durable output storage', async () => {
    const f = await fixture(async () => imageResponse(0.04));
    try {
      await f.worker.runOne();
      const capture = f.workerQueue.responseCapture(f.jobId);
      expect(capture).toHaveLength(1);
      expect(capture[0]).toMatchObject({
        httpStatus: 200,
        parseState: 'parsed',
        bodyAvailable: false,
        safeMetadata: {
          jsonValid: true,
          dataState: 'array',
          dataCount: 1,
          usageCostState: 'available',
          usageCostUsd: 0.04,
        },
      });
      const events = f.workerQueue.events(f.jobId).map((event) => event.event);
      expect(events.indexOf('raw_http_response_durably_preserved')).toBeLessThan(
        events.indexOf('response_outputs_durably_stored'),
      );
    } finally {
      await f.close();
    }
  });

  it('detects a corrupted preserved response before local recovery', async () => {
    const f = await fixture();
    try {
      f.adapterQueue.claimNext();
      f.adapterQueue.markCallPostStarted(f.jobId, 0);
      f.adapterQueue.saveRawResponse(
        f.jobId,
        0,
        { status: 200, contentType: 'application/json', body: Buffer.from('{"data":[]}') },
        f.config.maxRawResponseStorageBytes,
      );
      const db = new DatabaseSync(f.workerQueue.databasePath);
      try {
        db.prepare('UPDATE image_job_raw_responses SET body=? WHERE job_id=?').run(Buffer.from('corrupt'), f.jobId);
      } finally {
        db.close();
      }
      expect(() => f.workerQueue.preservedResponse(f.jobId, 0)).toThrow(
        expect.objectContaining({ code: 'PRESERVED_RESPONSE_CORRUPT' }),
      );
    } finally {
      await f.close();
    }
  });

  it('rolls back the response-preservation transaction when the database rejects the insert', async () => {
    const f = await fixture();
    try {
      f.adapterQueue.claimNext();
      f.adapterQueue.markCallPostStarted(f.jobId, 0);
      expect(() =>
        f.adapterQueue.saveRawResponse(
          'missing-job-id',
          0,
          { status: 200, contentType: 'application/json', body: Buffer.from('{"data":[]}') },
          f.config.maxRawResponseStorageBytes,
        ),
      ).toThrow();
      expect(f.workerQueue.responseCapture(f.jobId)).toEqual([]);
      expect(f.workerQueue.callState(f.jobId, 0)).toBe('post_started');
    } finally {
      await f.close();
    }
  });

  it('keeps an unrecoverable reconciliation-required record unchanged when local recovery has no body', async () => {
    const f = await fixture();
    try {
      f.adapterQueue.claimNext();
      f.adapterQueue.markCallPostStarted(f.jobId, 0);
      f.adapterQueue.uncertain(f.jobId, 'NETWORK_ERROR', 'simulated test record', null);
      f.adapterQueue.reconcile(f.jobId, 'confirm_charged', 'verified local test evidence', 0.05);
      const beforeJob = f.workerQueue.get(f.jobId);
      const beforeEvents = f.workerQueue.events(f.jobId);
      expect(() => f.workerQueue.recoverPreservedResponse(f.jobId)).toThrow(
        expect.objectContaining({ code: 'PRESERVED_RESPONSE_MISSING' }),
      );
      expect(f.workerQueue.get(f.jobId)).toEqual(beforeJob);
      expect(f.workerQueue.events(f.jobId)).toEqual(beforeEvents);
      expect(f.workerQueue.responseCapture(f.jobId)).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('keeps a paid response uncertain and never retries when durable response storage fails', async () => {
    let posts = 0;
    const f = await fixture(async (_input, init) => {
      if (init?.method === 'POST') posts += 1;
      return imageResponse(0.1);
    });
    const storage = vi.spyOn(f.workerQueue, 'saveRawResponse').mockImplementation(() => {
      throw new Error('simulated disk failure; never log response body');
    });
    try {
      await f.worker.runOne();
      expect(posts).toBe(1);
      expect(f.workerQueue.get(f.jobId)).toMatchObject({
        status: 'uncertain',
        errorCode: 'RAW_RESPONSE_PERSIST_ERROR',
        actualCostUsd: null,
      });
      expect(f.workerQueue.responseCapture(f.jobId)).toEqual([]);
      expect((await f.store.paidRequest(f.jobId))?.state).toBe('uncertain');
      expect(await f.worker.runOne()).toBe(false);
      expect(posts).toBe(1);
      expect(JSON.stringify(f.logs)).not.toContain('simulated disk failure');
      expect(JSON.stringify(f.logs)).not.toContain(pngBase64());
    } finally {
      storage.mockRestore();
      await f.close();
    }
  });

  it('recovers a preserved response after worker restart without sending a second POST', async () => {
    let posts = 0;
    const f = await fixture(async (_input, init) => {
      if (init?.method === 'POST') posts += 1;
      return imageResponse(0.04);
    });
    try {
      const raw = JSON.stringify({
        data: [{ b64_json: pngBase64(), media_type: 'image/png' }],
        usage: { cost: 0.04 },
      });
      f.adapterQueue.claimNext();
      f.adapterQueue.markCallPostStarted(f.jobId, 0);
      f.adapterQueue.saveRawResponse(
        f.jobId,
        0,
        { status: 200, contentType: 'application/json', body: Buffer.from(raw) },
        f.config.maxRawResponseStorageBytes,
      );
      f.adapterQueue.close();
      await f.worker.recover();
      expect(f.workerQueue.get(f.jobId)?.status).toBe('queued');
      await f.worker.runOne();
      expect(posts).toBe(0);
      expect(f.workerQueue.get(f.jobId)?.status).toBe('completed');
      expect(f.workerQueue.get(f.jobId)?.actualCostUsd).toBe(0.04);
      const usage = JSON.parse(await readFile(f.store.usagePath, 'utf8')) as Array<{ jobId: string }>;
      expect(usage.filter((item) => item.jobId === f.jobId)).toHaveLength(1);
      expect(f.workerQueue.responseCapture(f.jobId)[0]?.bodyAvailable).toBe(false);
    } finally {
      await f.close();
    }
  });

  it('accounts a higher reported charge than the estimate without losing the actual cost', async () => {
    const f = await fixture(async () => imageResponse(0.1));
    try {
      await f.worker.runOne();
      expect(f.workerQueue.get(f.jobId)?.status).toBe('completed');
      expect(f.workerQueue.get(f.jobId)?.estimateUsd).toBe(0.05);
      expect(f.workerQueue.get(f.jobId)?.actualCostUsd).toBe(0.1);
      expect((await f.store.usageForJob(f.jobId))?.costUsd).toBe(0.1);
    } finally {
      await f.close();
    }
  });

  it('refreshes Gemini pricing before reserving and before the first paid POST', async () => {
    let releaseResponse!: () => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let posts = 0;
    const f = await fixture(async (_input, init) => {
      if (init?.method === 'POST') {
        posts += 1;
        notifyStarted();
        await gate;
        return imageResponse(0.04);
      }
      throw new Error('Unexpected network request in mocked registry test');
    }, 160_000_000, true, 1);
    const registry = {
      image: async () => ({
        id: 'google/gemini-3.1-flash-lite-image',
        supported_parameters: {
          resolution: { type: 'enum', values: ['1K'] },
          input_references: { type: 'range', min: 0, max: 14 },
        },
      }),
      imagePricing: async () => [{ billable: 'output_image', unit: 'token', cost_usd: 0.00003 }],
      modelDetails: async () => ({
        id: 'google/gemini-3.1-flash-lite-image',
        context_length: 65_536,
        pricing: { prompt: 0.00000025, completion: 0.0000015, image_output: 0.00003 },
        top_provider: { context_length: 65_536, max_completion_tokens: 58_982 },
      }),
    } as unknown as ModelRegistry;
    try {
      const worker = new ImageJobWorker({
        config: f.config,
        client: f.client,
        registry,
        assets: f.assets,
        costs: f.costs,
        store: f.store,
        queue: f.workerQueue,
        logger: (entry) => f.logs.push(entry),
      });
      const running = worker.runOne();
      await started;
      expect(await f.store.paidRequest(f.jobId)).toMatchObject({ state: 'pending', budgetUsd: 0.138457 });
      expect(f.workerQueue.get(f.jobId)?.estimateUsd).toBe(0.138457);
      releaseResponse();
      await running;
      expect(posts).toBe(1);
      expect(f.workerQueue.get(f.jobId)?.status).toBe('completed');
      expect(f.workerQueue.get(f.jobId)?.estimateUsd).toBe(0.138457);
      expect(f.workerQueue.get(f.jobId)?.actualCostUsd).toBe(0.04);
    } finally {
      releaseResponse();
      await f.close();
    }
  });

  it('blocks before POST when the freshly fetched Gemini upper bound exceeds max_cost_usd', async () => {
    let posts = 0;
    const f = await fixture(async (_input, init) => {
      if (init?.method === 'POST') posts += 1;
      return imageResponse(0.04);
    }, 160_000_000, true, 0.05);
    const registry = {
      image: async () => ({
        id: 'google/gemini-3.1-flash-lite-image',
        supported_parameters: {
          resolution: { type: 'enum', values: ['1K'] },
          input_references: { type: 'range', min: 0, max: 14 },
        },
      }),
      imagePricing: async () => [{ billable: 'output_image', unit: 'token', cost_usd: 0.00003 }],
      modelDetails: async () => ({
        id: 'google/gemini-3.1-flash-lite-image',
        context_length: 65_536,
        pricing: { prompt: 0.00000025, completion: 0.0000015, image_output: 0.00003 },
        top_provider: { context_length: 65_536, max_completion_tokens: 58_982 },
      }),
    } as unknown as ModelRegistry;
    try {
      const worker = new ImageJobWorker({
        config: f.config,
        client: f.client,
        registry,
        assets: f.assets,
        costs: f.costs,
        store: f.store,
        queue: f.workerQueue,
        logger: (entry) => f.logs.push(entry),
      });
      await worker.runOne();
      expect(f.workerQueue.get(f.jobId)?.status).toBe('failed');
      expect(f.workerQueue.get(f.jobId)?.errorCode).toBe('REQUEST_COST_LIMIT');
      expect(f.workerQueue.get(f.jobId)?.estimateUsd).toBe(0.138457);
      expect(await f.store.paidRequests()).toEqual([]);
      expect(posts).toBe(0);
    } finally {
      await f.close();
    }
  });

  it.each([
    ['PNG', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...new Array(16).fill(0)]), 'image/png', '.png'],
    ['JPEG', Buffer.from(jpegBase64(), 'base64'), 'image/jpeg', '.jpg'],
    ['WebP', Buffer.from(webpBase64(), 'base64'), 'image/webp', '.webp'],
  ])('accepts a signature-verified %s image response', async (_name, bytes, mediaType, extension) => {
    const f = await fixture(async () =>
      responseWithData([{ b64_json: bytes.toString('base64'), media_type: mediaType }], 0.04),
    );
    try {
      await f.worker.runOne();
      const job = f.workerQueue.get(f.jobId);
      expect(job?.status).toBe('completed');
      expect(job?.files[0]).toMatch(new RegExp(`${extension.replace('.', '\\.')}$`));
    } finally {
      await f.close();
    }
  });

  it.each([
    ['invalid JSON', () => new Response('{broken json', { status: 200 }), 'INVALID_RESPONSE', null],
    ['missing data', () => responseWithData(undefined, 0.1), 'IMAGE_RESPONSE_DATA_MISSING', 0.1],
    ['empty data', () => responseWithData([], 0.1), 'IMAGE_RESPONSE_EMPTY', 0.1],
    ['missing base64', () => responseWithData([{ media_type: 'image/png' }], 0.1), 'IMAGE_DATA_MISSING', 0.1],
    ['invalid base64', () => responseWithData([{ b64_json: '%%%not-base64%%%' }], 0.1), 'INVALID_BASE64', 0.1],
    ['invalid image signature', () => responseWithData([{ b64_json: Buffer.from('not-image').toString('base64') }], 0.1), 'INVALID_IMAGE_FORMAT', 0.1],
    ['incorrect media type', () => responseWithData([{ b64_json: pngBase64(), media_type: 'image/jpeg' }], 0.1), 'IMAGE_MIME_MISMATCH', 0.1],
  ])('%s response is retained and its financial state is not reported as zero', async (_name, getResponse, errorCode, cost) => {
    let posts = 0;
    const f = await fixture(async (_input, init) => {
      if (init?.method === 'POST') posts += 1;
      return getResponse();
    });
    try {
      await f.worker.runOne();
      const job = f.workerQueue.get(f.jobId);
      expect(job?.status).toBe('reconciliation_required');
      expect(job?.errorCode).toBe(errorCode);
      expect(job?.actualCostUsd).toBe(cost);
      expect(job?.financialState).toBe(cost === null ? 'cost_unknown' : 'accounted');
      expect(f.workerQueue.responseCapture(f.jobId)[0]).toMatchObject({
        parseState: 'parse_failed',
        bodyAvailable: true,
      });
      const usage = await f.store.usageForJob(f.jobId);
      expect(usage?.costUsd).toBe(cost);
      if (cost === null) expect(usage?.unknownCost).toBe(true);
      expect(await f.worker.runOne()).toBe(false);
      expect(posts).toBe(1);
      expect(JSON.stringify(f.logs)).not.toContain(pngBase64());
    } finally {
      await f.close();
    }
  });

  it('preserves a response and actual cost when the image detector throws unexpectedly', async () => {
    let posts = 0;
    const f = await fixture(async (_input, init) => {
      if (init?.method === 'POST') posts += 1;
      return imageResponse(0.1);
    });
    try {
      const worker = new ImageJobWorker({
        config: f.config,
        client: f.client,
        assets: f.assets,
        costs: f.costs,
        store: f.store,
        queue: f.workerQueue,
        imageDetector: () => {
          throw new Error('secret prompt and base64 must not enter logs');
        },
        logger: (entry) => f.logs.push(entry),
      });
      await worker.runOne();
      const job = f.workerQueue.get(f.jobId);
      expect(job?.status).toBe('reconciliation_required');
      expect(job?.errorCode).toBe('WORKER_ERROR');
      expect(job?.actualCostUsd).toBe(0.1);
      expect(f.workerQueue.responseCapture(f.jobId)[0]?.bodyAvailable).toBe(true);
      expect(posts).toBe(1);
      expect(JSON.stringify(f.logs)).not.toContain('secret prompt');
      expect(JSON.stringify(f.logs)).not.toContain(pngBase64());
    } finally {
      await f.close();
    }
  });

  it('does not repeat a paid POST when the raw response storage quota is exhausted', async () => {
    let posts = 0;
    const f = await fixture(async (_input, init) => {
      if (init?.method === 'POST') posts += 1;
      return imageResponse(0.1);
    });
    try {
      f.config.maxRawResponseStorageBytes = 1;
      await f.worker.runOne();
      expect(f.workerQueue.get(f.jobId)?.status).toBe('uncertain');
      expect(f.workerQueue.get(f.jobId)?.errorCode).toBe('RAW_RESPONSE_STORAGE_LIMIT');
      expect(posts).toBe(1);
      expect(f.workerQueue.responseCapture(f.jobId)).toEqual([]);
      expect(await f.worker.runOne()).toBe(false);
    } finally {
      await f.close();
    }
  });

  it('stores safe transport diagnostics while preserving an uncertain reservation without retry', async () => {
    let posts = 0;
    const socketError = Object.assign(new Error('do not log this prompt or secret'), { code: 'ECONNRESET' });
    const f = await fixture(async (_input, init) => {
      if (init?.method === 'POST') {
        posts += 1;
        throw new TypeError('fetch failed', { cause: socketError });
      }
      return imageResponse();
    });
    try {
      await f.worker.runOne();
      const job = f.workerQueue.get(f.jobId);
      expect(job?.status).toBe('uncertain');
      expect(job?.httpStatus).toBeNull();
      expect(job?.errorMessage).toContain('ECONNRESET');
      expect((await f.store.paidRequest(f.jobId))?.state).toBe('uncertain');
      const errorLog = f.logs.find((entry) => entry.event === 'job_error');
      expect(errorLog).toMatchObject({
        network_phase: 'request_or_waiting_for_headers',
        network_outcome: 'network_error',
        network_timed_out: false,
        error_codes: ['ECONNRESET'],
      });
      expect(errorLog?.request_duration_ms).toEqual(expect.any(Number));
      expect(JSON.stringify(f.logs)).not.toContain('do not log this prompt or secret');
      expect(JSON.stringify(f.logs)).not.toContain('test-secret-never-log');
      expect(await f.worker.runOne()).toBe(false);
      expect(posts).toBe(1);
    } finally {
      await f.close();
    }
  });

  it('does not report completed when local persistence fails after a paid response', async () => {
    const f = await fixture(async () => imageResponse(0.04));
    try {
      const brokenAssets = {
        outputDirectory: async (outputDir: string) => ({ root: f.root, directory: outputDir }),
        saveImage: async () => {
          throw new Error('disk write failed');
        },
      } as unknown as AssetManager;
      const worker = new ImageJobWorker({
        config: f.config,
        client: f.client,
        assets: f.assets,
        costs: f.costs,
        store: f.store,
        queue: f.workerQueue,
        logger: () => undefined,
        assetsForJob: () => brokenAssets,
      });
      await worker.runOne();
      expect(f.workerQueue.get(f.jobId)?.status).toBe('reconciliation_required');
      expect(f.workerQueue.get(f.jobId)?.deliveryState).toBe('failed_after_response');
      expect(f.workerQueue.get(f.jobId)?.actualCostUsd).toBe(0.04);
      expect((await f.store.usageForJob(f.jobId))?.costUsd).toBe(0.04);
      expect(await f.store.paidRequests()).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('requires explicit audited reconciliation and preserves recorded costs', async () => {
    const f = await fixture();
    try {
      f.adapterQueue.claimNext();
      await f.costs.authorize(
        {
          status: 'estimated',
          estimateUsd: 0.05,
          source: 'test',
          confidence: 'high',
          parameters: {},
          limitations: [],
        },
        { allowPaid: true },
        'generate_image',
        f.workerQueue.get(f.jobId)!.fingerprint,
        f.jobId,
      );
      f.adapterQueue.markCallPostStarted(f.jobId, 0);
      f.workerQueue.uncertain(f.jobId, 'NETWORK_ERROR', 'response was lost', null);
      await f.store.markPaidRequestUncertain(f.jobId, {
        model: f.payload.model,
        estimateUsd: 0.05,
        operation: 'generate_image_uncertain',
      });
      await f.store.completePaidRequest(f.jobId, {
        at: new Date().toISOString(),
        model: f.payload.model,
        costUsd: 0.07,
        budgetUsd: 0.07,
        unknownCost: false,
        operation: 'generate_image',
        jobId: f.jobId,
      });
      f.workerQueue.reconcile(f.jobId, 'confirm_charged', 'OpenRouter activity record checked', 0.07);
      expect(f.workerQueue.get(f.jobId)?.financialState).toBe('accounted_by_reconciliation');
      expect(f.workerQueue.get(f.jobId)?.status).toBe('reconciliation_required');
      expect((await f.store.usageForJob(f.jobId))?.costUsd).toBe(0.07);
      expect(await f.store.paidRequests()).toEqual([]);
      expect(f.workerQueue.events(f.jobId).at(-1)?.event).toBe('confirm_charged');
      expect(f.workerQueue.get(f.jobId)?.payload.prompt).toBe('test image');
      expect(f.workerQueue.list()).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it('keeps prompts, API keys, and image base64 out of structured logs', async () => {
    const f = await fixture(async () => imageResponse());
    try {
      f.adapterQueue.close();
      await f.worker.runOne();
      const serialized = JSON.stringify(f.logs);
      expect(serialized).not.toContain('test image');
      expect(serialized).not.toContain('test-secret-never-log');
      expect(serialized).not.toContain(pngBase64());
      expect(serialized).toContain(f.jobId);
    } finally {
      await f.close();
    }
  });
});
