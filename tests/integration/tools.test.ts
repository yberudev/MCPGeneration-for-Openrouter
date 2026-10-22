import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { createApp } from '../../src/server.js';

function imageCatalog() {
  return {
    data: [
      {
        id: 'google/gemini-3.1-flash-lite-image',
        name: 'Nano Banana 2 Lite',
        description: 'Mock image model',
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
        supported_parameters: {
          resolution: { type: 'enum', values: ['1K'] },
          aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] },
          n: { type: 'range', min: 1, max: 1 },
          input_references: { type: 'range', min: 0, max: 14 },
        },
        endpoints: '/api/v1/images/models/google/gemini-3.1-flash-lite-image/endpoints',
      },
    ],
  };
}

function videoCatalog(includeConfigurableAudio = false) {
  return {
    data: [
      {
        id: 'heygen/heygen-video-1',
        name: 'HeyGen Video',
        description: 'Mock video model',
        supported_resolutions: ['480p', '768p', '2K'],
        supported_aspect_ratios: ['1:1', '16:9', '9:16'],
        supported_durations: [5, 10],
        supported_frame_images: ['first_frame'],
        generate_audio: false,
        pricing_skus: {
          duration_seconds_480p: '0.02',
          reference_duration_seconds_480p: '0.07',
          reference_input_images: '0.04',
        },
      },
      ...(includeConfigurableAudio
        ? [
            {
              id: 'google/veo-3.1',
              name: 'Veo 3.1',
              description: 'Mock model with configurable audio',
              supported_resolutions: ['480p'],
              supported_aspect_ratios: ['16:9'],
              supported_durations: [5],
              supported_frame_images: ['first_frame'],
              generate_audio: true,
              pricing_skus: {
                duration_seconds_480p: '0.02',
                audio_generation: '0.01',
              },
            },
          ]
        : []),
    ],
  };
}

function pngData() {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(32, 16);
  png.writeUInt32BE(32, 20);
  return png.toString('base64');
}

async function withMcp(
  fetchImpl: typeof fetch,
  test: (client: Client, root: string, dir: string) => Promise<void>,
  overrides: Record<string, string> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-integration-'));
  const root = join(dir, 'project');
  await mkdir(root);
  const config = loadConfig({
    OPENROUTER_API_KEY: 'test-secret',
    YBERU_PROJECT_ROOT: root,
    YBERU_DATA_DIR: join(dir, 'data'),
    MAX_COST_PER_REQUEST_USD: '5',
    MAX_TOTAL_SPEND_USD: '20',
    ...overrides,
  });
  const app = await createApp(config, fetchImpl);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await app.server.connect(serverTransport);
  const client = new Client({ name: 'mcp-generation-test', version: '1.0.0' });
  await client.connect(clientTransport);
  try {
    await test(client, root, dir);
  } finally {
    await client.close();
  }
}

describe('MCP tool integration with mocked OpenRouter responses', () => {
  it('performs handshake and advertises all ten tools', async () => {
    await withMcp(
      async () => new Response('{}'),
      async (client) => {
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual([
          'animate_image',
          'download_video',
          'edit_image',
          'estimate_cost',
          'generate_image',
          'generate_variations',
          'generate_video',
          'get_video_status',
          'list_assets',
          'list_models',
        ]);
      },
    );
  });

  it('returns current model capabilities and structured content', async () => {
    const fetchMock: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/images/models')) return Response.json(imageCatalog());
      if (url.endsWith('/videos/models')) return Response.json(videoCatalog());
      throw new Error(`Unexpected request: ${url}`);
    };
    await withMcp(fetchMock, async (client) => {
      const result = await client.callTool({ name: 'list_models', arguments: { type: 'all' } });
      expect(result.isError).not.toBe(true);
      const content = result.structuredContent as {
        models: Array<{ id: string; capabilities: Record<string, unknown> }>;
      };
      expect(content.models).toHaveLength(2);
      expect(
        content.models.find((model) => model.id.includes('heygen'))?.capabilities.durations_seconds,
      ).toEqual([5, 10]);
      expect(
        content.models.find((model) => model.id.includes('heygen'))?.capabilities.audio_policy,
      ).toMatchObject({
        mode: 'always_on',
        configurable: false,
        canDisable: false,
        catalogValue: false,
      });
    });
  });

  it('generates and stores an image using a mocked response and records actual usage', async () => {
    let sawAuth = false;
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (headers.get('authorization') === 'Bearer test-secret') sawAuth = true;
      if (url.endsWith('/images/models')) return Response.json(imageCatalog());
      if (url.endsWith('/images/models/google/gemini-3.1-flash-lite-image/endpoints')) {
        return Response.json({
          endpoints: [{ pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.05 }] }],
        });
      }
      if (url.endsWith('/images') && init?.method === 'POST') {
        return Response.json({
          data: [{ b64_json: pngData(), media_type: 'image/png' }],
          usage: { cost: 0.04 },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    await withMcp(fetchMock, async (client, root, dir) => {
      const result = await client.callTool({
        name: 'generate_image',
        arguments: { prompt: 'A tiny green dragon', allow_paid: true },
      });
      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as {
        files: Array<{ path: string; mime_type: string }>;
        usage: { cost_usd: number };
      };
      expect(structured.files[0]?.path).toContain(root);
      expect(structured.files[0]?.mime_type).toBe('image/png');
      expect(structured.usage.cost_usd).toBe(0.04);
      expect(sawAuth).toBe(true);
      expect((await readFile(structured.files[0]!.path)).length).toBe(24);
      const assets = JSON.parse(await readFile(join(dir, 'data', 'assets.json'), 'utf8')) as unknown[];
      const usage = JSON.parse(await readFile(join(dir, 'data', 'usage.json'), 'utf8')) as Array<{
        costUsd: number;
      }>;
      expect(assets).toHaveLength(1);
      expect(usage[0]?.costUsd).toBe(0.04);
    });
  });

  it('edits a local reference, makes requested variations without n support, and lists assets', async () => {
    const sentBodies: Array<Record<string, unknown>> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/images/models')) return Response.json(imageCatalog());
      if (url.endsWith('/images/models/google/gemini-3.1-flash-lite-image/endpoints')) {
        return Response.json({
          endpoints: [{ pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.05 }] }],
        });
      }
      if (url.endsWith('/images') && init?.method === 'POST') {
        sentBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({
          data: [{ b64_json: pngData(), media_type: 'image/png' }],
          usage: { cost: 0.04 },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    await withMcp(fetchMock, async (client, root) => {
      const input = join(root, 'source.png');
      await writeFile(input, Buffer.from(pngData(), 'base64'));
      const edited = await client.callTool({
        name: 'edit_image',
        arguments: { prompt: 'Move the subject to a forest', input_image_path: input, allow_paid: true },
      });
      expect(edited.isError).not.toBe(true);
      const editOutput = edited.structuredContent as {
        files: Array<{ path: string }>;
        generation_id: string;
      };
      expect(editOutput.files).toHaveLength(1);
      expect(editOutput.generation_id).toBeTruthy();
      expect(sentBodies[0]?.input_references).toEqual([
        { type: 'image_url', image_url: { url: expect.stringContaining('data:image/png;base64,') } },
      ]);

      const variations = await client.callTool({
        name: 'generate_variations',
        arguments: { prompt: 'A green dragon mascot', count: 2, allow_paid: true },
      });
      expect(variations.isError).not.toBe(true);
      const variationOutput = variations.structuredContent as {
        files: Array<{ path: string }>;
        generation_id: string;
        count: number;
      };
      expect(variationOutput.count).toBe(2);
      expect(variationOutput.files.map((file) => file.path)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/variation-.+-01\.png$/),
          expect.stringMatching(/variation-.+-02\.png$/),
        ]),
      );
      expect(sentBodies).toHaveLength(3);
      expect(sentBodies[1]?.n).toBeUndefined();
      expect(sentBodies[2]?.prompt).not.toBe(sentBodies[1]?.prompt);

      const assets = await client.callTool({ name: 'list_assets', arguments: { type: 'image' } });
      const list = assets.structuredContent as {
        count: number;
        assets: Array<{ generation_id: string | null; related_asset_path: string | null }>;
      };
      expect(list.count).toBe(3);
      expect(
        list.assets.some(
          (asset) => asset.generation_id === editOutput.generation_id && asset.related_asset_path === input,
        ),
      ).toBe(true);

      const estimate = await client.callTool({
        name: 'estimate_cost',
        arguments: { type: 'image', model: 'google/gemini-3.1-flash-lite-image', operation: 'generate' },
      });
      expect((estimate.structuredContent as { estimateUsd: number }).estimateUsd).toBe(0.05);
    });
  });

  it('persists successful variations and their cost if a later paid request is rejected', async () => {
    let posts = 0;
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/images/models')) return Response.json(imageCatalog());
      if (url.endsWith('/images/models/google/gemini-3.1-flash-lite-image/endpoints')) {
        return Response.json({
          endpoints: [{ pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.05 }] }],
        });
      }
      if (url.endsWith('/images') && init?.method === 'POST') {
        posts += 1;
        if (posts === 1) return Response.json({ data: [{ b64_json: pngData() }], usage: { cost: 0.04 } });
        return Response.json({ error: 'rate limit' }, { status: 429 });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    await withMcp(fetchMock, async (client, _root, dir) => {
      const result = await client.callTool({
        name: 'generate_variations',
        arguments: { prompt: 'A green dragon mascot', count: 2, allow_paid: true },
      });
      expect(result.isError).not.toBe(true);
      const output = result.structuredContent as {
        count: number;
        partial_failure?: string;
        files: Array<{ path: string }>;
      };
      expect(output.count).toBe(1);
      expect(output.partial_failure).toContain('429');
      expect((await readFile(output.files[0]!.path)).length).toBe(24);
      const usage = JSON.parse(await readFile(join(dir, 'data', 'usage.json'), 'utf8')) as Array<{
        costUsd: number;
      }>;
      expect(usage[0]?.costUsd).toBe(0.04);
      expect(JSON.parse(await readFile(join(dir, 'data', 'requests.json'), 'utf8'))).toEqual([]);
    });
    expect(posts).toBe(2);
  });

  it('animates a local image through first_frame and persists no base64 in task metadata', async () => {
    let submittedBody: Record<string, unknown> | undefined;
    let posts = 0;
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/videos/models')) return Response.json(videoCatalog());
      if (url.endsWith('/videos') && init?.method === 'POST') {
        posts += 1;
        submittedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json({ id: 'animate-job-1', status: 'pending' }, { status: 202 });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    await withMcp(fetchMock, async (client, root, dir) => {
      const input = join(root, 'dragon.png');
      await writeFile(input, Buffer.from(pngData(), 'base64'));
      const result = await client.callTool({
        name: 'animate_image',
        arguments: { prompt: 'The dragon waves', input_image_path: input, allow_paid: true },
      });
      expect(result.isError).not.toBe(true);
      const job = result.structuredContent as {
        job_id: string;
        remote_job_id: string;
        status: string;
        estimate: { estimateUsd: number };
        audio_policy: { mode: string };
      };
      expect(job.status).toBe('pending');
      expect(job.estimate.estimateUsd).toBe(0.1);
      expect(job.audio_policy.mode).toBe('always_on');
      expect(submittedBody?.generate_audio).toBeUndefined();
      const frames = submittedBody?.frame_images as Array<{ frame_type: string; image_url: { url: string } }>;
      expect(frames[0]?.frame_type).toBe('first_frame');
      expect(frames[0]?.image_url.url).toContain('data:image/png;base64,');
      const stored = await readFile(join(dir, 'data', 'jobs.json'), 'utf8');
      expect(stored).not.toContain('data:image/png;base64,');
      expect(stored).toContain(input);
      const jobs = JSON.parse(stored) as Array<{
        id: string;
        remoteId: string;
        status: string;
        config: Record<string, unknown>;
      }>;
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        id: job.job_id,
        remoteId: job.remote_job_id,
        status: 'pending',
      });
      expect(jobs[0]?.config.generate_audio).toBeUndefined();
      expect(JSON.parse(await readFile(join(dir, 'data', 'requests.json'), 'utf8'))).toEqual([]);
      expect(posts).toBe(1);
    });
  });

  it('rejects explicit HeyGen audio disable locally before reserving or posting', async () => {
    let posts = 0;
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/videos/models')) return Response.json(videoCatalog());
      if (url.endsWith('/videos') && init?.method === 'POST') {
        posts += 1;
        return Response.json({ id: 'unexpected' }, { status: 202 });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    await withMcp(fetchMock, async (client, root, dir) => {
      const input = join(root, 'dragon.png');
      await writeFile(input, Buffer.from(pngData(), 'base64'));
      const result = await client.callTool({
        name: 'animate_image',
        arguments: {
          prompt: 'The dragon waves silently',
          model: 'heygen/heygen-video-1',
          input_image_path: input,
          generate_audio: false,
          allow_paid: true,
        },
      });
      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: string }).error).toContain('VIDEO_AUDIO_REQUIRED');
      expect((result.structuredContent as { error: string }).error).toContain('exige áudio');
      await expect(readFile(join(dir, 'data', 'requests.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
    expect(posts).toBe(0);
  });

  it('preserves explicit true and false for models that advertise configurable audio', async () => {
    const submitted: Array<Record<string, unknown>> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/videos/models')) return Response.json(videoCatalog(true));
      if (url.endsWith('/videos') && init?.method === 'POST') {
        submitted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({ id: `veo-job-${submitted.length}`, status: 'pending' }, { status: 202 });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    await withMcp(fetchMock, async (client, _root, dir) => {
      for (const value of [true, false]) {
        const result = await client.callTool({
          name: 'generate_video',
          arguments: {
            prompt: `Audio option ${value}`,
            model: 'google/veo-3.1',
            duration: 5,
            resolution: '480p',
            aspect_ratio: '16:9',
            generate_audio: value,
            allow_paid: true,
          },
        });
        expect(result.isError).not.toBe(true);
      }
      expect(submitted.map((body) => body.generate_audio)).toEqual([true, false]);
      const jobs = JSON.parse(await readFile(join(dir, 'data', 'jobs.json'), 'utf8')) as Array<{
        config: { generate_audio?: boolean };
      }>;
      expect(jobs.map((job) => job.config.generate_audio)).toEqual([true, false]);
    });
  });

  it('shows the exact HeyGen dry-run payload shape without base64 or an audio flag', async () => {
    let posts = 0;
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/videos/models')) return Response.json(videoCatalog());
      if (url.endsWith('/videos') && init?.method === 'POST') {
        posts += 1;
        return Response.json({ id: 'unexpected' }, { status: 202 });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    await withMcp(fetchMock, async (client, root) => {
      const input = join(root, 'dragon.png');
      await writeFile(input, Buffer.from(pngData(), 'base64'));
      const result = await client.callTool({
        name: 'animate_image',
        arguments: {
          prompt: 'The dragon waves',
          model: 'heygen/heygen-video-1',
          input_image_path: input,
          duration: 5,
          resolution: '480p',
          aspect_ratio: '1:1',
          dry_run: true,
        },
      });
      expect(result.isError).not.toBe(true);
      const dryRun = result.structuredContent as {
        configuration: Record<string, unknown>;
        estimate: { estimateUsd: number };
      };
      expect(dryRun.configuration).toEqual({
        model: 'heygen/heygen-video-1',
        prompt: 'The dragon waves',
        duration: 5,
        resolution: '480p',
        aspect_ratio: '1:1',
        frame_images: [
          {
            type: 'image_url',
            frame_type: 'first_frame',
            image_url: { url: '[data URL image/png omitida]' },
          },
        ],
      });
      expect(JSON.stringify(dryRun.configuration)).not.toContain('base64');
      expect(dryRun.estimate.estimateUsd).toBe(0.1);
      const estimate = await client.callTool({
        name: 'estimate_cost',
        arguments: {
          type: 'video',
          model: 'heygen/heygen-video-1',
          operation: 'animate',
          duration: 5,
          resolution: '480p',
        },
      });
      expect(estimate.isError).not.toBe(true);
      expect(estimate.structuredContent).toMatchObject({
        estimateUsd: 0.1,
        audio_policy: { mode: 'always_on' },
        audio_parameter: 'omitted',
      });
      const cannotDisableAudio = await client.callTool({
        name: 'estimate_cost',
        arguments: {
          type: 'video',
          model: 'heygen/heygen-video-1',
          operation: 'animate',
          duration: 5,
          resolution: '480p',
          generate_audio: false,
        },
      });
      expect(cannotDisableAudio.isError).toBe(true);
      expect((cannotDisableAudio.structuredContent as { error: string }).error).toContain(
        'VIDEO_AUDIO_REQUIRED',
      );
    });
    expect(posts).toBe(0);
  });

  it('releases a cost reservation after HTTP 400 and never retries the paid POST', async () => {
    let posts = 0;
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/videos/models')) return Response.json(videoCatalog());
      if (url.endsWith('/videos') && init?.method === 'POST') {
        posts += 1;
        return Response.json({ error: 'invalid video parameters' }, { status: 400 });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    await withMcp(fetchMock, async (client, _root, dir) => {
      const result = await client.callTool({
        name: 'generate_video',
        arguments: {
          prompt: 'A fox waves',
          model: 'heygen/heygen-video-1',
          duration: 5,
          resolution: '480p',
          allow_paid: true,
        },
      });
      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: string }).error).toContain('HTTP 400');
      expect(JSON.parse(await readFile(join(dir, 'data', 'requests.json'), 'utf8'))).toEqual([]);
      await expect(readFile(join(dir, 'data', 'usage.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
    expect(posts).toBe(1);
  });

  it('submits a video job, persists it, polls completion, and streams a mock MP4', async () => {
    let submittedBody: Record<string, unknown> | undefined;
    let statusCalls = 0;
    const video = Buffer.alloc(32);
    video.write('ftyp', 4);
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/videos/models')) return Response.json(videoCatalog());
      if (url.endsWith('/videos') && init?.method === 'POST') {
        submittedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json({ id: 'remote-job-1', status: 'pending' }, { status: 202 });
      }
      if (url.endsWith('/videos/remote-job-1')) {
        statusCalls += 1;
        return Response.json({ id: 'remote-job-1', status: 'completed', usage: { cost: 0.1 } });
      }
      if (url.includes('/videos/remote-job-1/content?index=0'))
        return new Response(video, {
          headers: { 'content-type': 'video/mp4', 'content-length': String(video.length) },
        });
      throw new Error(`Unexpected request: ${url}`);
    };
    await withMcp(fetchMock, async (client, root, dir) => {
      const generated = await client.callTool({
        name: 'generate_video',
        arguments: { prompt: 'A fox waves', allow_paid: true },
      });
      const job = generated.structuredContent as { job_id: string; remote_job_id: string; status: string };
      expect(job.status).toBe('pending');
      expect(submittedBody?.duration).toBe(5);
      expect(submittedBody?.resolution).toBe('480p');
      expect(await readFile(join(dir, 'data', 'jobs.json'), 'utf8')).toContain(job.remote_job_id);

      const status = await client.callTool({ name: 'get_video_status', arguments: { job_id: job.job_id } });
      expect((status.structuredContent as { status: string }).status).toBe('completed');
      const download = await client.callTool({
        name: 'download_video',
        arguments: { job_id: job.job_id, filename: 'fox.mp4' },
      });
      const file = download.structuredContent as { path: string; relative_path: string; mime_type: string };
      expect(file.path).toContain(root);
      expect(file.mime_type).toBe('video/mp4');
      expect(file.relative_path).toContain('fox.mp4');
      expect((await readFile(file.path)).length).toBe(32);
      expect(statusCalls).toBe(2);
    });
  });

  it('cleans up an interrupted video download, resumes safely, and is idempotent', async () => {
    let interrupt = true;
    let downloads = 0;
    let posts = 0;
    const video = Buffer.alloc(32);
    video.write('ftyp', 4);
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/videos/models')) return Response.json(videoCatalog());
      if (url.endsWith('/videos') && init?.method === 'POST') {
        posts += 1;
        return Response.json({ id: 'recover-job', status: 'pending' }, { status: 202 });
      }
      if (url.endsWith('/videos/recover-job'))
        return Response.json({ id: 'recover-job', status: 'completed', usage: { cost: 0.1 } });
      if (url.includes('/videos/recover-job/content?index=0')) {
        downloads += 1;
        if (interrupt) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(video.subarray(0, 8));
              controller.error(new Error('connection interrupted'));
            },
          });
          return new Response(stream, { headers: { 'content-type': 'video/mp4' } });
        }
        return new Response(video, {
          headers: { 'content-type': 'video/mp4', 'content-length': String(video.length) },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    await withMcp(fetchMock, async (client, root) => {
      const created = await client.callTool({
        name: 'generate_video',
        arguments: { prompt: 'A short fox clip', allow_paid: true },
      });
      const job = created.structuredContent as { job_id: string };
      const failedDownload = await client.callTool({
        name: 'download_video',
        arguments: { job_id: job.job_id },
      });
      expect(failedDownload.isError).toBe(true);
      const outputDir = join(root, 'public/assets/generated/videos');
      expect((await readdir(outputDir)).filter((name) => name.endsWith('.download'))).toHaveLength(0);

      interrupt = false;
      const recovered = await client.callTool({
        name: 'download_video',
        arguments: { job_id: job.job_id, filename: 'recovered.mp4' },
      });
      expect(recovered.isError).not.toBe(true);
      const second = await client.callTool({ name: 'download_video', arguments: { job_id: job.job_id } });
      expect(second.isError).not.toBe(true);
      expect((second.structuredContent as { idempotent: boolean }).idempotent).toBe(true);
      expect(downloads).toBe(2);
      expect(posts).toBe(1);
    });
  });
});
