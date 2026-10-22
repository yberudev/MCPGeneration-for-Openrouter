import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { createApp } from '../../src/server.js';

const explicitOptIn = process.env.RUN_PAID_TESTS === 'true';
const apiKeyAvailable = Boolean(process.env.OPENROUTER_API_KEY);
const authorizedCostPolicy = process.env.ALLOW_UNKNOWN_COST === 'true';
const projectRoot = process.env.YBERU_PROJECT_ROOT ?? process.env.CLAUDE_PROJECT_DIR;
const maxCost = Number(process.env.PAID_TEST_MAX_COST_USD);

describe.skipIf(
  !explicitOptIn ||
    !apiKeyAvailable ||
    !authorizedCostPolicy ||
    !projectRoot ||
    !Number.isFinite(maxCost) ||
    maxCost <= 0,
)('OpenRouter paid smoke test (explicit opt-in only)', () => {
  it('generates one image and saves it in the explicitly configured project root', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mcp-generation-paid-test-'));
    const config = loadConfig({
      ...process.env,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      YBERU_PROJECT_ROOT: projectRoot,
      YBERU_DATA_DIR: dataDir,
      ALLOW_UNKNOWN_COST: 'true',
      MAX_COST_PER_REQUEST_USD: String(maxCost),
      MAX_TOTAL_SPEND_USD: process.env.MAX_TOTAL_SPEND_USD ?? '20',
    });
    const app = await createApp(config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await app.server.connect(serverTransport);
    const client = new Client({ name: 'mcp-generation-paid-test', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: 'generate_image',
        arguments: {
          prompt: 'A simple blue geometric flower on a plain white background; paid integration smoke test.',
          model: process.env.PAID_TEST_MODEL ?? config.defaultImageModel,
          output_dir:
            process.env.PAID_TEST_OUTPUT_DIR ??
            join(config.projectRoot!, 'public/assets/generated/paid-tests'),
          filename: `paid-smoke-${Date.now()}.png`,
          allow_paid: true,
          max_cost_usd: maxCost,
        },
      });
      expect(result.isError).not.toBe(true);
      const output = result.structuredContent as { files?: Array<{ path: string }> };
      expect(output.files?.[0]?.path).toContain(config.projectRoot);
    } finally {
      await client.close();
    }
  }, 180_000);
});
