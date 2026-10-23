import { performance } from 'node:perf_hooks';
import { AppError } from '../../utils/errors.js';
import {
  getTransportDiagnostic,
  OpenRouterTransportError,
  transportDiagnostic,
  type TransportDiagnostic,
} from './diagnostics.js';
import { apiError } from './errors.js';
import {
  imageGenerationResponseSchema,
  imageModelsResponseSchema,
  videoJobResponseSchema,
  videoModelsResponseSchema,
} from './schemas.js';
import type {
  ImageGenerationResponse,
  ImageModel,
  OpenRouterImageRequest,
  OpenRouterVideoRequest,
  VideoJobResponse,
  VideoModel,
} from '../../types/openrouter.js';

interface OpenRouterClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

export interface NetworkProbeResult {
  name: 'authenticated_key_get' | 'unauthenticated_invalid_post';
  http_status: number | null;
  duration_ms: number;
  http_reachable: boolean;
  error_code?: string;
  transport?: TransportDiagnostic;
}

export interface PreservedOpenRouterResponse {
  status: number;
  contentType: string | null;
  body: Buffer;
}

export class OpenRouterClient {
  private readonly fetchImpl: typeof fetch;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: OpenRouterClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxResponseBytes = options.maxResponseBytes ?? 160_000_000;
  }

  private url(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  }

  private safeUrl(path: string): URL {
    const base = new URL(this.options.baseUrl);
    const target = new URL(this.url(path));
    if (
      target.protocol !== 'https:' ||
      target.hostname !== 'openrouter.ai' ||
      target.origin !== base.origin ||
      target.username ||
      target.password
    ) {
      throw new AppError(
        'Pedido bloqueado: a chave só pode ser enviada ao host oficial do OpenRouter por HTTPS.',
        'UNSAFE_API_DESTINATION',
      );
    }
    return target;
  }

  private headers(json = false, requireApiKey = true, sendApiKey = true): HeadersInit {
    if (requireApiKey && !this.options.apiKey) {
      throw new AppError('Define OPENROUTER_API_KEY no ambiente do servidor.', 'MISSING_API_KEY');
    }
    return {
      ...(sendApiKey && this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  private parseResponse<T>(
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown } },
    value: unknown,
    label: string,
  ): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new AppError(`Resposta inválida do OpenRouter (${label}).`, 'INVALID_RESPONSE', {
        cause: parsed.error,
      });
    return parsed.data;
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit = {},
    requireApiKey = true,
    onResponse?: (response: Response, requestDurationMs: number) => void,
    sendApiKey = true,
    onRawResponse?: (response: PreservedOpenRouterResponse) => void | Promise<void>,
  ): Promise<T> {
    const requestStarted = performance.now();
    const signal = init.signal ?? AbortSignal.timeout(this.options.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.safeUrl(path), {
        ...init,
        headers: { ...this.headers(init.body !== undefined, requireApiKey, sendApiKey), ...init.headers },
        // Do not follow redirects: even same-origin redirects are unnecessary for
        // these fixed API routes, and a redirect can never receive the bearer key.
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new OpenRouterTransportError(
        'Falha de rede ou timeout ao contactar o OpenRouter. O pedido não foi repetido.',
        'NETWORK_ERROR',
        error,
        transportDiagnostic(error, 'request_or_waiting_for_headers', performance.now() - requestStarted, signal),
      );
    }
    const requestDurationMs = Math.round(performance.now() - requestStarted);
    onResponse?.(response, requestDurationMs);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new OpenRouterTransportError(
        `O OpenRouter respondeu com redirecionamento HTTP ${response.status}; o pedido foi bloqueado sem reenviar credenciais.`,
        'REDIRECT_BLOCKED',
        undefined,
        {
          phase: 'redirect',
          transport_layer: 'http',
          outcome: 'redirect_blocked',
          duration_ms: requestDurationMs,
          timed_out: false,
          error_codes: [],
          error_names: [],
        },
      );
    }
    if (!response.ok) {
      let detail: string;
      try {
        detail = await this.readTextLimited(response, 16_384);
      } catch (error) {
        throw new OpenRouterTransportError(
          `OpenRouter respondeu HTTP ${response.status}, mas o corpo de erro não pôde ser lido.`,
          `OPENROUTER_HTTP_${response.status}`,
          error,
          transportDiagnostic(error, 'response_body', performance.now() - requestStarted, signal, 'response_read_error'),
        );
      }
      if (this.options.apiKey) detail = detail.replaceAll(this.options.apiKey, '[redacted]');
      throw apiError(response.status, detail);
    }
    try {
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
        await response.body?.cancel();
        throw new AppError(
          `Resposta do OpenRouter excede MAX_HTTP_RESPONSE_BYTES (${this.maxResponseBytes}).`,
          'RESPONSE_TOO_LARGE',
        );
      }
      if (!response.body) throw new Error('empty body');
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          throw new OpenRouterTransportError(
            'A ligação falhou durante a leitura da resposta do OpenRouter.',
            'RESPONSE_READ_ERROR',
            error,
            transportDiagnostic(error, 'response_body', performance.now() - requestStarted, signal, 'response_read_error'),
          );
        }
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > this.maxResponseBytes) {
          await reader.cancel();
          throw new AppError(
            `Resposta do OpenRouter excede MAX_HTTP_RESPONSE_BYTES (${this.maxResponseBytes}).`,
            'RESPONSE_TOO_LARGE',
          );
        }
        chunks.push(Buffer.from(chunk.value));
      }
      const rawBody = Buffer.concat(chunks, total);
      if (onRawResponse) {
        try {
          await onRawResponse({
            status: response.status,
            contentType: response.headers.get('content-type'),
            body: rawBody,
          });
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError(
            'A resposta HTTP recebida não pôde ser preservada no armazenamento local.',
            'RAW_RESPONSE_PERSIST_ERROR',
            { cause: error },
          );
        }
      }
      try {
        return JSON.parse(rawBody.toString('utf8')) as T;
      } catch (error) {
        throw new OpenRouterTransportError(
          'O OpenRouter devolveu um corpo que não é JSON válido.',
          'INVALID_RESPONSE',
          error,
          transportDiagnostic(error, 'response_parse', performance.now() - requestStarted, signal, 'invalid_json'),
        );
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new OpenRouterTransportError(
        'Falha ao ler a resposta do OpenRouter.',
        'RESPONSE_READ_ERROR',
        error,
        transportDiagnostic(error, 'response_body', performance.now() - requestStarted, signal, 'response_read_error'),
      );
    }
  }

  private async readTextLimited(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < maxBytes) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const take = chunk.value.subarray(0, maxBytes - total);
      chunks.push(Buffer.from(take));
      total += take.byteLength;
      if (take.byteLength < chunk.value.byteLength) break;
    }
    await reader.cancel().catch(() => undefined);
    return Buffer.concat(chunks, total).toString('utf8');
  }

  async listImageModels(): Promise<ImageModel[]> {
    const response = imageModelsResponseSchema.safeParse(
      await this.requestJson<unknown>('/images/models', {}, false),
    );
    if (!response.success)
      throw new AppError('Catálogo de imagens com formato inesperado.', 'INVALID_CATALOG', {
        cause: response.error,
      });
    return response.data.data as ImageModel[];
  }

  async listVideoModels(): Promise<VideoModel[]> {
    const response = videoModelsResponseSchema.safeParse(
      await this.requestJson<unknown>('/videos/models', {}, false),
    );
    if (!response.success)
      throw new AppError('Catálogo de vídeos com formato inesperado.', 'INVALID_CATALOG', {
        cause: response.error,
      });
    return response.data.data as VideoModel[];
  }

  async getModelEndpointDetails(id: string): Promise<unknown> {
    const parts = id.split('/');
    if (parts.length !== 2 || !parts.every((part) => /^[a-zA-Z0-9._-]+$/.test(part)))
      throw new AppError('O catálogo devolveu um id de modelo inválido.', 'INVALID_CATALOG_MODEL_ID');
    return this.requestJson<unknown>(`/models/${parts.map(encodeURIComponent).join('/')}/endpoints`, {}, false);
  }

  async getImageModelEndpoints(path: string): Promise<unknown> {
    if (!path.startsWith('/api/v1/images/models/') || path.includes('..')) {
      throw new AppError('O catálogo devolveu um caminho de endpoint inválido.', 'INVALID_CATALOG_PATH');
    }
    return this.requestJson(path.replace(/^\/api\/v1/, ''), {}, false);
  }

  generateImage(body: OpenRouterImageRequest): Promise<ImageGenerationResponse> {
    return this.generateImageWithStatus(body).then((result) => result.response);
  }

  async generateImageWithStatus(
    body: OpenRouterImageRequest,
    onHttpResponse?: (status: number, requestDurationMs: number) => void,
    onRawResponse?: (response: PreservedOpenRouterResponse) => void | Promise<void>,
  ): Promise<{ response: ImageGenerationResponse; status: number }> {
    let status = 0;
    const value = await this.requestJson<unknown>(
      '/images',
      { method: 'POST', body: JSON.stringify(body) },
      true,
      (response, requestDurationMs) => {
        status = response.status;
        onHttpResponse?.(response.status, requestDurationMs);
      },
      true,
      onRawResponse,
    );
    return {
      response: this.parseResponse(imageGenerationResponseSchema, value, 'imagem') as ImageGenerationResponse,
      status,
    };
  }

  parseImageGenerationResponseBody(body: Uint8Array): ImageGenerationResponse {
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
    } catch (error) {
      throw new OpenRouterTransportError(
        'A resposta preservada do OpenRouter não é JSON válido.',
        'INVALID_RESPONSE',
        error,
        transportDiagnostic(error, 'response_parse', 0, undefined, 'invalid_json'),
      );
    }
    return this.parseResponse(imageGenerationResponseSchema, value, 'imagem') as ImageGenerationResponse;
  }

  createVideo(body: OpenRouterVideoRequest): Promise<VideoJobResponse> {
    return this.requestJson<unknown>('/videos', { method: 'POST', body: JSON.stringify(body) }).then(
      (value) => this.parseResponse(videoJobResponseSchema, value, 'tarefa de vídeo') as VideoJobResponse,
    );
  }

  getVideo(jobId: string): Promise<VideoJobResponse> {
    return this.requestJson<unknown>(`/videos/${encodeURIComponent(jobId)}`).then(
      (value) => this.parseResponse(videoJobResponseSchema, value, 'estado de vídeo') as VideoJobResponse,
    );
  }

  private async probe(
    name: NetworkProbeResult['name'],
    path: string,
    init: RequestInit,
    requireApiKey: boolean,
    sendApiKey: boolean,
  ): Promise<NetworkProbeResult> {
    const started = performance.now();
    let httpStatus: number | null = null;
    let requestDurationMs = 0;
    try {
      await this.requestJson<unknown>(
        path,
        init,
        requireApiKey,
        (response, durationMs) => {
          httpStatus = response.status;
          requestDurationMs = durationMs;
        },
        sendApiKey,
      );
      return {
        name,
        http_status: httpStatus,
        duration_ms: requestDurationMs,
        http_reachable: httpStatus !== null,
      };
    } catch (error) {
      const diagnostic =
        error instanceof AppError && /^OPENROUTER_HTTP_\d{3}$/.test(error.code)
          ? Number(error.code.slice(-3))
          : null;
      const transport = getTransportDiagnostic(error);
      return {
        name,
        http_status: httpStatus ?? diagnostic,
        duration_ms: transport?.duration_ms ?? (requestDurationMs || Math.round(performance.now() - started)),
        http_reachable: httpStatus !== null || diagnostic !== null,
        ...(error instanceof AppError ? { error_code: error.code } : { error_code: 'NETWORK_ERROR' }),
        ...(transport ? { transport } : {}),
      };
    }
  }

  async diagnoseNetwork(): Promise<NetworkProbeResult[]> {
    const key = await this.probe('authenticated_key_get', '/key', { method: 'GET' }, true, true);
    const unauthenticatedPost = await this.probe(
      'unauthenticated_invalid_post',
      '/chat/completions',
      { method: 'POST', body: '{}' },
      false,
      false,
    );
    return [key, unauthenticatedPost];
  }

  async downloadVideo(jobId: string, index: number): Promise<Response> {
    const requestStarted = performance.now();
    const signal = AbortSignal.timeout(this.options.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(
        this.safeUrl(`/videos/${encodeURIComponent(jobId)}/content?index=${index}`),
        {
          headers: this.headers(),
          redirect: 'manual',
          signal,
        },
      );
    } catch (error) {
      throw new OpenRouterTransportError(
        'Falha de rede ou timeout ao descarregar o vídeo. Tente novamente sem criar uma nova geração.',
        'DOWNLOAD_NETWORK_ERROR',
        error,
        transportDiagnostic(error, 'request_or_waiting_for_headers', performance.now() - requestStarted, signal),
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new OpenRouterTransportError(
        `O OpenRouter respondeu com redirecionamento HTTP ${response.status}; o pedido foi bloqueado sem reenviar credenciais.`,
        'REDIRECT_BLOCKED',
        undefined,
        {
          phase: 'redirect',
          transport_layer: 'http',
          outcome: 'redirect_blocked',
          duration_ms: Math.round(performance.now() - requestStarted),
          timed_out: false,
          error_codes: [],
          error_names: [],
        },
      );
    }
    if (!response.ok) {
      let detail: string;
      try {
        detail = await this.readTextLimited(response, 16_384);
      } catch {
        detail = 'Não foi possível ler o corpo de erro.';
      }
      if (this.options.apiKey) detail = detail.replaceAll(this.options.apiKey, '[redacted]');
      throw apiError(response.status, detail);
    }
    return response;
  }
}
