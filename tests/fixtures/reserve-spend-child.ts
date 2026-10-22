import { AppError } from '../../src/utils/errors.js';
import { loadConfig } from '../../src/config/env.js';
import { CostGuard } from '../../src/services/cost-guard.js';
import { MetadataStore } from '../../src/services/metadata-store.js';

const [dataDir, fingerprint] = process.argv.slice(2);
if (!dataDir || !fingerprint) throw new Error('Expected data directory and fingerprint arguments.');

const store = new MetadataStore(dataDir);
await store.init();
const guard = new CostGuard(
  loadConfig({
    YBERU_DATA_DIR: dataDir,
    MAX_COST_PER_REQUEST_USD: '1',
    MAX_TOTAL_SPEND_USD: '1',
  }),
  store,
);

try {
  await guard.authorize(
    {
      status: 'estimated',
      estimateUsd: 0.75,
      source: 'process-lock-test',
      confidence: 'high',
      parameters: {},
      limitations: [],
    },
    { allowPaid: true },
    'generate_video',
    fingerprint,
  );
  process.stdout.write('reserved');
} catch (error) {
  if (error instanceof AppError) process.stdout.write(error.code);
  else throw error;
}
