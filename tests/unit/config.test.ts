import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';

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
});
