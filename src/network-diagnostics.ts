import { loadConfig } from './config/env.js';
import { OpenRouterClient } from './providers/openrouter/client.js';

const config = loadConfig();
const client = new OpenRouterClient({
  baseUrl: config.baseUrl,
  ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  timeoutMs: Math.min(config.httpTimeoutMs, 15_000),
  maxResponseBytes: 1_000_000,
});

const probes = await client.diagnoseNetwork();
process.stdout.write(
  `${JSON.stringify({
    event: 'openrouter_network_diagnostics',
    node_version: process.version,
    undici_version: process.versions.undici,
    api_key_loaded: Boolean(config.apiKey),
    probes,
  })}\n`,
);

if (probes[0]?.http_status !== 200 || !probes[1]?.http_reachable) process.exitCode = 1;
