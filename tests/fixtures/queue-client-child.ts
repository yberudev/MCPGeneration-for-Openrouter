import { ImageJobQueue, type ImageJobPayload } from '../../src/services/image-job-queue.js';
import type { OpenRouterImageRequest } from '../../src/types/openrouter.js';

const [dataDir, root] = process.argv.slice(2);
if (!dataDir || !root) throw new Error('Expected data directory and authorized root arguments.');
const queue = new ImageJobQueue(dataDir);
await queue.init();
const body: OpenRouterImageRequest = {
  model: 'google/gemini-3.1-flash-lite-image',
  prompt: 'child adapter job',
};
const payload: ImageJobPayload = {
  operation: 'generate_image',
  model: body.model,
  prompt: body.prompt,
  requestBodies: [body],
  outputRoot: root,
  resolvedOutputDir: `${root}/public/assets/generated/images`,
  estimateUsd: 0.05,
  estimateSource: 'mock catalog',
  estimateUnknownCost: false,
  maxCostUsd: 5,
  maxCostPerRequestUsd: 5,
  maxTotalSpendUsd: 20,
  allowUnknownCost: false,
  expectedOutputCount: 1,
};
const created = queue.enqueue(payload, body);
process.stdout.write(`${JSON.stringify({ jobId: created.job.id })}\n`);
process.on('SIGTERM', () => {
  queue.close();
  process.exit(0);
});
setInterval(() => undefined, 60_000);
