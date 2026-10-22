import { McpServer } from '@modelcontextprotocol/server';
import type { AppConfig } from './config/env.js';
import { SERVER_NAME, SERVER_VERSION } from './config/defaults.js';
import { OpenRouterClient } from './providers/openrouter/client.js';
import { AssetManager } from './services/asset-manager.js';
import { CostGuard } from './services/cost-guard.js';
import { JobManager } from './services/job-manager.js';
import { MetadataStore } from './services/metadata-store.js';
import { ModelRegistry } from './services/model-registry.js';
import { registerCatalogTools } from './tools/catalog-tools.js';
import { registerImageTools } from './tools/image-tools.js';
import { registerVideoTools } from './tools/video-tools.js';

export interface AppServices {
  server: McpServer;
  config: AppConfig;
  client: OpenRouterClient;
  registry: ModelRegistry;
  assets: AssetManager;
  costs: CostGuard;
  jobs: JobManager;
  store: MetadataStore;
}

export async function createApp(config: AppConfig, fetchImpl?: typeof fetch): Promise<AppServices> {
  const store = new MetadataStore(config.dataDir);
  await store.init();
  const client = new OpenRouterClient({
    baseUrl: config.baseUrl,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    timeoutMs: config.httpTimeoutMs,
    maxResponseBytes: config.maxHttpResponseBytes,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const registry = new ModelRegistry(client);
  const assets = new AssetManager(config, store);
  const costs = new CostGuard(config, store);
  const jobs = new JobManager(store);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerCatalogTools(server, { config, registry, assets, costs });
  registerImageTools(server, { config, client, registry, assets, costs, store });
  registerVideoTools(server, { config, client, registry, assets, costs, jobs, store });
  return { server, config, client, registry, assets, costs, jobs, store };
}
