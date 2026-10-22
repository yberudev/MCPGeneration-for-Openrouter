import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { createApp } from '../../src/server.js';

const enabled = process.env.RUN_LIVE_CATALOG_TESTS === 'true';

async function withLiveApp<T>(
  work: (client: Client, requests: string[], projectRoot: string) => Promise<T>,
): Promise<T> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'mcp-openrouter-live-'));
  const projectRoot = join(tempRoot, 'project');
  await mkdir(projectRoot);
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    requests.push(method.toUpperCase());
    return fetch(input, init);
  };
  const app = await createApp(
    loadConfig({ YBERU_PROJECT_ROOT: projectRoot, YBERU_DATA_DIR: join(tempRoot, 'data') }),
    fetchImpl,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await app.server.connect(serverTransport);
  const client = new Client({ name: 'mcp-generation-live-catalog-test', version: '1.0.0' });
  await client.connect(clientTransport);
  try {
    return await work(client, requests, projectRoot);
  } finally {
    await client.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function resultData<T>(result: { isError?: boolean; structuredContent?: unknown }): T {
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
  return result.structuredContent as T;
}

describe.skipIf(!enabled)('live OpenRouter catalogs and dry runs (GET only)', () => {
  it('recognizes Nano Banana 2, Nano Banana 2 Lite, and HeyGen Video from live catalogs', async () => {
    await withLiveApp(async (client, requests) => {
      const result = await client.callTool({
        name: 'list_models',
        arguments: { type: 'all', search: 'gemini-3.1-flash', refresh: true },
      });
      const imageCatalog = resultData<{
        models: Array<{ id: string; type: string; capabilities: Record<string, unknown> }>;
      }>(result);
      const lite = imageCatalog.models.find((model) => model.id === 'google/gemini-3.1-flash-lite-image');
      const full = imageCatalog.models.find((model) => model.id === 'google/gemini-3.1-flash-image');
      expect(lite?.type).toBe('image');
      expect(full?.type).toBe('image');
      expect((lite?.capabilities.resolution as { values: string[] }).values).toContain('1K');
      expect((full?.capabilities.resolution as { values: string[] }).values).toContain('4K');
      expect(lite?.capabilities.input_references).toMatchObject({ min: 0, max: 14 });

      const videoResult = await client.callTool({
        name: 'list_models',
        arguments: { type: 'video', search: 'heygen/heygen-video-1', refresh: true },
      });
      const videoCatalog = resultData<{
        models: Array<{
          id: string;
          type: string;
          capabilities: Record<string, unknown>;
          pricing: Record<string, string>;
        }>;
      }>(videoResult);
      const heygen = videoCatalog.models.find((model) => model.id === 'heygen/heygen-video-1');
      expect(heygen?.type).toBe('video');
      expect(heygen?.capabilities.frame_images).toContain('first_frame');
      expect(heygen?.capabilities.audio_policy).toMatchObject({
        mode: 'always_on',
        configurable: false,
        canDisable: false,
        catalogValue: false,
      });
      expect(heygen?.pricing).toMatchObject({
        duration_seconds_480p: '0.02',
        reference_duration_seconds_480p: '0.07',
        reference_input_images: '0.04',
      });
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((method) => method === 'GET')).toBe(true);
    });
  }, 60_000);

  it('builds documented image, edit, video, and first-frame requests without any POST', async () => {
    await withLiveApp(async (client, requests, projectRoot) => {
      const imageBytes = Buffer.alloc(24);
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(imageBytes);
      imageBytes.writeUInt32BE(32, 16);
      imageBytes.writeUInt32BE(32, 20);
      const sourcePath = join(projectRoot, `mcp-live-source-${Date.now()}.png`);
      await writeFile(sourcePath, imageBytes);
      try {
        const generated = resultData<{
          dry_run: boolean;
          request: Record<string, unknown>;
          estimate: { status: string; estimateUsd: number | null };
        }>(
          await client.callTool({
            name: 'generate_image',
            arguments: {
              prompt: 'dry-run validation only',
              model: 'google/gemini-3.1-flash-lite-image',
              aspect_ratio: '16:9',
              resolution: '1K',
              dry_run: true,
            },
          }),
        );
        expect(generated.dry_run).toBe(true);
        expect(generated.request).toMatchObject({
          model: 'google/gemini-3.1-flash-lite-image',
          prompt: 'dry-run validation only',
          aspect_ratio: '16:9',
          resolution: '1K',
        });
        expect(generated.estimate.status).toBe('unknown');

        const edited = resultData<{
          dry_run: boolean;
          request: {
            model: string;
            input_references: Array<{ type: string; image_url: { url: string } }>;
          };
        }>(
          await client.callTool({
            name: 'edit_image',
            arguments: {
              prompt: 'dry-run edit validation only',
              model: 'google/gemini-3.1-flash-image',
              input_image_path: sourcePath,
              dry_run: true,
            },
          }),
        );
        expect(edited.request.model).toBe('google/gemini-3.1-flash-image');
        expect(edited.request.input_references[0]).toMatchObject({
          type: 'image_url',
          image_url: { url: expect.stringContaining('data URL image/png omitida') },
        });

        const video = resultData<{
          dry_run: boolean;
          audio_policy: { mode: string };
          configuration: Record<string, unknown>;
          estimate: { estimateUsd: number };
        }>(
          await client.callTool({
            name: 'generate_video',
            arguments: {
              prompt: 'dry-run video validation only',
              model: 'heygen/heygen-video-1',
              duration: 5,
              resolution: '480p',
              aspect_ratio: '16:9',
              dry_run: true,
            },
          }),
        );
        expect(video.configuration).toEqual({
          model: 'heygen/heygen-video-1',
          prompt: 'dry-run video validation only',
          duration: 5,
          resolution: '480p',
          aspect_ratio: '16:9',
        });
        expect(video.configuration.generate_audio).toBeUndefined();
        expect(video.audio_policy.mode).toBe('always_on');
        expect(video.estimate.estimateUsd).toBe(0.1);

        const animated = resultData<{
          dry_run: boolean;
          audio_policy: { mode: string };
          configuration: {
            frame_images: Array<{ type: string; frame_type: string; image_url: { url: string } }>;
          };
          estimate: { estimateUsd: number; parameters: Record<string, unknown> };
        }>(
          await client.callTool({
            name: 'animate_image',
            arguments: {
              prompt: 'dry-run animation validation only',
              model: 'heygen/heygen-video-1',
              input_image_path: sourcePath,
              duration: 5,
              resolution: '480p',
              aspect_ratio: '16:9',
              dry_run: true,
            },
          }),
        );
        expect(animated.configuration.frame_images[0]).toMatchObject({
          type: 'image_url',
          frame_type: 'first_frame',
          image_url: { url: expect.stringContaining('data URL image/png omitida') },
        });
        expect(animated.configuration.generate_audio).toBeUndefined();
        expect(JSON.stringify(animated.configuration)).not.toContain('base64');
        expect(animated.audio_policy.mode).toBe('always_on');
        expect(animated.estimate.estimateUsd).toBe(0.1);
        expect(animated.estimate.parameters.inputMode).toBe('frame_images');

        const references = resultData<{
          estimateUsd: number;
          parameters: Record<string, unknown>;
        }>(
          await client.callTool({
            name: 'estimate_cost',
            arguments: {
              type: 'video',
              model: 'heygen/heygen-video-1',
              duration: 5,
              resolution: '480p',
              reference_image_count: 1,
            },
          }),
        );
        expect(references.estimateUsd).toBe(0.39);
        expect(references.parameters.inputMode).toBe('input_references');
      } finally {
        await rm(sourcePath, { force: true });
      }
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((method) => method === 'GET')).toBe(true);
    });
  }, 60_000);
});
