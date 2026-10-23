import { loadConfig } from './config/env.js';
import { OpenRouterClient } from './providers/openrouter/client.js';
import { AssetManager } from './services/asset-manager.js';
import { CostGuard } from './services/cost-guard.js';
import { ImageJobQueue } from './services/image-job-queue.js';
import { ImageJobWorker } from './services/image-job-worker.js';
import { MetadataStore } from './services/metadata-store.js';
import { sanitizeErrorMessage } from './utils/errors.js';

const config = loadConfig();
const store = new MetadataStore(config.dataDir);
await store.init();
const queue = new ImageJobQueue(config.dataDir);
await queue.init();
const client = new OpenRouterClient({
  baseUrl: config.baseUrl,
  ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  timeoutMs: config.httpTimeoutMs,
  maxResponseBytes: config.maxHttpResponseBytes,
});
const worker = new ImageJobWorker({
  config,
  client,
  assets: new AssetManager(config, store),
  costs: new CostGuard(config, store),
  store,
  queue,
});

process.on('SIGTERM', () => worker.requestStop());
process.on('SIGINT', () => worker.requestStop());

try {
  await worker.run();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ event: 'worker_fatal', error: sanitizeErrorMessage(error) })}\n`);
  process.exitCode = 1;
} finally {
  queue.close();
}
