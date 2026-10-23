import { homedir } from 'node:os';
import { config as loadDotEnv } from 'dotenv';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';

export function resolveServerRoot(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '../..');
}

const serverRoot = resolveServerRoot(import.meta.url);

export function loadServerEnvironment(
  root = serverRoot,
  externalEnvPath = join(homedir(), '.config', 'mcp-generation', 'worker.env'),
): void {
  const inherited = { ...process.env };
  loadDotEnv({ path: externalEnvPath, quiet: true });
  loadDotEnv({ path: join(root, '.env'), quiet: true });
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) process.env[key] = value;
  }
}

loadServerEnvironment();

const optionalText = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().optional(),
);

const rawSchema = z.object({
  OPENROUTER_API_KEY: optionalText,
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  DEFAULT_IMAGE_MODEL: z.string().min(1).default('google/gemini-3.1-flash-lite-image'),
  DEFAULT_VIDEO_MODEL: z.string().min(1).default('heygen/heygen-video-1'),
  YBERU_PROJECT_ROOT: optionalText,
  YBERU_ALLOWED_ROOTS: optionalText,
  YBERU_ASSETS_DIR: z.string().min(1).default('public/assets/generated'),
  YBERU_DATA_DIR: optionalText,
  MAX_COST_PER_REQUEST_USD: z.coerce.number().positive().default(5),
  MAX_TOTAL_SPEND_USD: z.coerce.number().positive().default(20),
  MAX_IMAGE_VARIATIONS: z.coerce.number().int().min(1).max(20).default(4),
  MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(25_000_000),
  MAX_HTTP_RESPONSE_BYTES: z.coerce.number().int().positive().default(160_000_000),
  MAX_RAW_RESPONSE_STORAGE_BYTES: z.coerce.number().int().positive().default(536_870_912),
  MAX_VIDEO_BYTES: z.coerce.number().int().positive().default(524_288_000),
  HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  VIDEO_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  ALLOW_UNKNOWN_COST: z.enum(['true', 'false']).default('false'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface AppConfig {
  apiKey?: string;
  baseUrl: string;
  defaultImageModel: string;
  defaultVideoModel: string;
  projectRoot?: string;
  allowedRoots: string[];
  assetsDir: string;
  dataDir: string;
  maxCostPerRequestUsd: number;
  maxTotalSpendUsd: number;
  maxImageVariations: number;
  maxImageBytes: number;
  maxHttpResponseBytes: number;
  maxRawResponseStorageBytes: number;
  maxVideoBytes: number;
  httpTimeoutMs: number;
  videoPollIntervalMs: number;
  allowUnknownCost: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = rawSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Configuração inválida: ${details}`);
  }

  const values = parsed.data;
  const projectRootText = values.YBERU_PROJECT_ROOT ?? env.CLAUDE_PROJECT_DIR;
  const projectRoot = projectRootText ? resolve(projectRootText) : undefined;
  const roots = [
    ...(projectRoot ? [projectRoot] : []),
    ...(values.YBERU_ALLOWED_ROOTS
      ? values.YBERU_ALLOWED_ROOTS.split(delimiter)
          .filter(Boolean)
          .map((path) => resolve(path))
      : []),
  ];
  const uniqueRoots = [...new Set(roots)];
  const dataDir = values.YBERU_DATA_DIR
    ? resolve(values.YBERU_DATA_DIR)
    : join(homedir(), '.local', 'share', 'mcp-generation-openrouter');

  if (values.YBERU_DATA_DIR && !isAbsolute(values.YBERU_DATA_DIR)) {
    throw new Error('YBERU_DATA_DIR deve ser um caminho absoluto.');
  }
  if (values.OPENROUTER_BASE_URL.startsWith('http://')) {
    throw new Error('OPENROUTER_BASE_URL deve utilizar HTTPS.');
  }
  const base = new URL(values.OPENROUTER_BASE_URL);
  if (base.username || base.password || base.search || base.hash) {
    throw new Error('OPENROUTER_BASE_URL não pode conter credenciais, query ou fragmento.');
  }
  if (base.hostname !== 'openrouter.ai') {
    throw new Error(
      'OPENROUTER_BASE_URL tem de usar o host oficial openrouter.ai; a chave não será enviada a outros hosts.',
    );
  }
  if (base.pathname.replace(/\/$/, '') !== '/api/v1') {
    throw new Error('OPENROUTER_BASE_URL deve apontar para https://openrouter.ai/api/v1.');
  }

  return {
    ...(values.OPENROUTER_API_KEY ? { apiKey: values.OPENROUTER_API_KEY } : {}),
    baseUrl: values.OPENROUTER_BASE_URL.replace(/\/$/, ''),
    defaultImageModel: values.DEFAULT_IMAGE_MODEL,
    defaultVideoModel: values.DEFAULT_VIDEO_MODEL,
    ...(projectRoot ? { projectRoot } : {}),
    allowedRoots: uniqueRoots,
    assetsDir: values.YBERU_ASSETS_DIR,
    dataDir,
    maxCostPerRequestUsd: values.MAX_COST_PER_REQUEST_USD,
    maxTotalSpendUsd: values.MAX_TOTAL_SPEND_USD,
    maxImageVariations: values.MAX_IMAGE_VARIATIONS,
    maxImageBytes: values.MAX_IMAGE_BYTES,
    maxHttpResponseBytes: values.MAX_HTTP_RESPONSE_BYTES,
    maxRawResponseStorageBytes: values.MAX_RAW_RESPONSE_STORAGE_BYTES,
    maxVideoBytes: values.MAX_VIDEO_BYTES,
    httpTimeoutMs: values.HTTP_TIMEOUT_MS,
    videoPollIntervalMs: values.VIDEO_POLL_INTERVAL_MS,
    allowUnknownCost: values.ALLOW_UNKNOWN_COST === 'true',
    logLevel: values.LOG_LEVEL,
  };
}
