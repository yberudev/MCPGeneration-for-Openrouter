import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig, loadServerEnvironment, resolveServerRoot } from '../../src/config/env.js';

describe('loadConfig', () => {
  it('applies secure defaults and does not require an API key at startup', () => {
    const config = loadConfig({});
    expect(config.apiKey).toBeUndefined();
    expect(config.maxCostPerRequestUsd).toBe(5);
    expect(config.maxTotalSpendUsd).toBe(20);
    expect(config.allowUnknownCost).toBe(false);
  });

  it('rejects insecure or malformed configuration', () => {
    expect(() => loadConfig({ OPENROUTER_BASE_URL: 'http://example.com' })).toThrow('HTTPS');
    expect(() => loadConfig({ MAX_TOTAL_SPEND_USD: '-1' })).toThrow('Configuração inválida');
  });

  it('uses Claude Code project directory when explicit project root is absent', () => {
    const config = loadConfig({ CLAUDE_PROJECT_DIR: '/tmp/claude-project' });
    expect(config.projectRoot).toBe('/tmp/claude-project');
    expect(config.allowedRoots).toContain('/tmp/claude-project');
  });

  it('loads the server installation .env when Claude starts it from another project', async () => {
    const serverRoot = await mkdtemp(join(tmpdir(), 'mcp-server-env-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'mcp-active-project-'));
    await writeFile(join(serverRoot, '.env'), 'OPENROUTER_API_KEY=server-installation-key\n');
    const previousKey = process.env.OPENROUTER_API_KEY;
    const previousCwd = process.cwd();
    try {
      delete process.env.OPENROUTER_API_KEY;
      process.chdir(projectRoot);
      const installedEnvModule = pathToFileURL(join(serverRoot, 'dist', 'config', 'env.js')).href;
      const resolvedServerRoot = resolveServerRoot(installedEnvModule);
      expect(resolvedServerRoot).toBe(serverRoot);
      loadServerEnvironment(resolvedServerRoot);
      expect(loadConfig().apiKey).toBe('server-installation-key');
    } finally {
      process.chdir(previousCwd);
      if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousKey;
    }
  });
});
