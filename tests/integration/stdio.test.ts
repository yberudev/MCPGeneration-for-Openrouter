import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

describe('stdio process', () => {
  it('completes MCP discovery over stdio and advertises tools without stdout noise', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mcp-stdio-'));
    const environment = {
      ...getDefaultEnvironment(),
      OPENROUTER_API_KEY: '',
      YBERU_DATA_DIR: dataDir,
      CLAUDE_PROJECT_DIR: dataDir,
    };
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', resolve('src/index.ts')],
      cwd: resolve('.'),
      env: environment,
      stderr: 'pipe',
    });
    const stderr: string[] = [];
    transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      const result = await client.listTools();
      expect(result.tools).toHaveLength(10);
      expect(stderr.join('')).not.toContain('OPENROUTER_API_KEY');
    } finally {
      await client.close();
    }
  }, 20_000);
});
