import { AppError } from '../../utils/errors.js';
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

  private headers(json = false, requireApiKey = true): HeadersInit {
    if (requireApiKey && !this.options.apiKey) {
      throw new AppError('Define OPENROUTER_API_KEY no ambiente do servidor.', 'MISSING_API_KEY');
    }
    return {
      ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
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
    onResponse?: (response: Response) => void,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), {
        ...init,
        headers: { ...this.headers(init.body !== undefined, requireApiKey), ...init.headers },
        redirect: 'error',
        signal: init.signal ?? AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'Falha de rede ou timeout ao contactar o OpenRouter. O pedido não foi repetido.',
        'NETWORK_ERROR',
        {
          cause: error,
        },
      );
    }
    onResponse?.(response);
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
        const chunk = await reader.read();
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
      return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as T;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('O OpenRouter devolveu JSON inválido.', 'INVALID_RESPONSE', { cause: error });
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
    onHttpResponse?: (status: number) => void,
  ): Promise<{ response: ImageGenerationResponse; status: number }> {
    let status = 0;
    const value = await this.requestJson<unknown>(
      '/images',
      { method: 'POST', body: JSON.stringify(body) },
      true,
      (response) => {
        status = response.status;
        onHttpResponse?.(response.status);
      },
    );
    return {
      response: this.parseResponse(imageGenerationResponseSchema, value, 'imagem') as ImageGenerationResponse,
      status,
    };
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

  async downloadVideo(jobId: string, index: number): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        this.url(`/videos/${encodeURIComponent(jobId)}/content?index=${index}`),
        {
          headers: this.headers(),
          redirect: 'error',
          signal: AbortSignal.timeout(this.options.timeoutMs),
        },
      );
    } catch (error) {
      throw new AppError(
        'Falha de rede ou timeout ao descarregar o vídeo. Tente novamente sem criar uma nova geração.',
        'DOWNLOAD_NETWORK_ERROR',
        {
          cause: error,
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
