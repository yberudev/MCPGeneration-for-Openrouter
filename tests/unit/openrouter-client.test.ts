import { describe, expect, it } from 'vitest';
import { OpenRouterClient } from '../../src/providers/openrouter/client.js';

describe('OpenRouterClient', () => {
  it('sanitizes HTTP errors and does not retry paid POST requests', async () => {
    let calls = 0;
    const client = new OpenRouterClient({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-test-secret',
      timeoutMs: 1_000,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: 'sk-or-another-secret invalid payment' }), {
          status: 402,
        });
      },
    });
    await expect(client.generateImage({ model: 'example/image', prompt: 'x' })).rejects.toMatchObject({
      code: 'OPENROUTER_HTTP_402',
    });
    expect(calls).toBe(1);
    await expect(client.listImageModels()).rejects.toThrow('créditos insuficientes');
  });

  it('allows public catalog GETs without a key and protects authenticated API calls', async () => {
    const missingKey = new OpenRouterClient({
      baseUrl: 'https://openrouter.ai/api/v1',
      timeoutMs: 1_000,
      fetchImpl: async (_input, init) => {
        expect(new Headers(init?.headers).has('authorization')).toBe(false);
        return Response.json({ data: [] });
      },
    });
    await expect(missingKey.listVideoModels()).resolves.toEqual([]);
    await expect(missingKey.getVideo('job-1')).rejects.toMatchObject({ code: 'MISSING_API_KEY' });
    const malformed = new OpenRouterClient({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test',
      timeoutMs: 1_000,
      fetchImpl: async () => Response.json({ data: [{ name: 'no-id' }] }),
    });
    await expect(malformed.listImageModels()).rejects.toMatchObject({ code: 'INVALID_CATALOG' });
  });

  it('does not expose a key when a fetch fails', async () => {
    const client = new OpenRouterClient({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-private',
      timeoutMs: 1_000,
      fetchImpl: async () => {
        throw new Error('network failed');
      },
    });
    await expect(client.listVideoModels()).rejects.toThrow('Falha de rede');
    await expect(client.listVideoModels()).rejects.not.toThrow('sk-or-private');
  });

  it.each([
    [401, 'chave OpenRouter é inválida'],
    [402, 'créditos insuficientes'],
    [429, 'Limite de requisições'],
  ])('translates HTTP %i errors into safe messages', async (status, expected) => {
    const client = new OpenRouterClient({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-secret',
      timeoutMs: 1_000,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: `request failed: test-secret (${status})` }), { status }),
    });
    await expect(client.downloadVideo('job-1', 0)).rejects.toThrow(expected);
    await expect(client.downloadVideo('job-1', 0)).rejects.not.toThrow('test-secret');
  });
});
