import { AppError } from '../utils/errors.js';
import type { ImageModel, OpenRouterModelDetails, VideoModel } from '../types/openrouter.js';
import type { OpenRouterClient } from '../providers/openrouter/client.js';

export class ModelRegistry {
  private imageCache?: { expires: number; models: ImageModel[] };
  private videoCache?: { expires: number; models: VideoModel[] };
  private readonly modelDetailsCache = new Map<
    string,
    { expires: number; model?: OpenRouterModelDetails }
  >();
  private readonly ttlMs = 5 * 60_000;

  constructor(
    private readonly client: OpenRouterClient,
    private readonly now = Date.now,
  ) {}

  async images(refresh = false): Promise<ImageModel[]> {
    if (!refresh && this.imageCache && this.imageCache.expires > this.now()) return this.imageCache.models;
    const models = await this.client.listImageModels();
    this.imageCache = { expires: this.now() + this.ttlMs, models };
    return models;
  }

  async videos(refresh = false): Promise<VideoModel[]> {
    if (!refresh && this.videoCache && this.videoCache.expires > this.now()) return this.videoCache.models;
    const models = await this.client.listVideoModels();
    this.videoCache = { expires: this.now() + this.ttlMs, models };
    return models;
  }

  async modelDetails(id: string, refresh = false): Promise<OpenRouterModelDetails | undefined> {
    const cached = this.modelDetailsCache.get(id);
    if (refresh || !cached || cached.expires <= this.now()) {
      const details = await this.client.getModelEndpointDetails(id);
      const root = details && typeof details === 'object' && 'data' in details
        ? (details as { data?: unknown }).data
        : undefined;
      const endpointItems = root && typeof root === 'object' && 'endpoints' in root
        ? (root as { endpoints?: unknown }).endpoints
        : undefined;
      if (!Array.isArray(endpointItems)) {
        this.modelDetailsCache.set(id, { expires: this.now() + this.ttlMs });
        return undefined;
      }
      const endpoints = endpointItems.filter(
        (endpoint): endpoint is Record<string, unknown> => Boolean(endpoint) && typeof endpoint === 'object',
      );
      const maximum = (values: unknown[]): number | undefined => {
        const parsed = values.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0);
        return parsed.length === values.length && parsed.length > 0 ? Math.max(...parsed) : undefined;
      };
      const contextLength = maximum(endpoints.map((endpoint) => endpoint.context_length));
      const maxCompletionTokens = maximum(endpoints.map((endpoint) => endpoint.max_completion_tokens));
      const price = (key: string): number | undefined =>
        maximum(
          endpoints.map((endpoint) => {
            const pricing = endpoint.pricing;
            return pricing && typeof pricing === 'object' && key in pricing
              ? (pricing as Record<string, unknown>)[key]
              : undefined;
          }),
        );
      const prompt = price('prompt');
      const completion = price('completion');
      const imageOutput = price('image_output');
      const model: OpenRouterModelDetails = {
        id,
        ...(contextLength !== undefined ? { context_length: contextLength } : {}),
        pricing: {
          ...(prompt !== undefined ? { prompt } : {}),
          ...(completion !== undefined ? { completion } : {}),
          ...(imageOutput !== undefined ? { image_output: imageOutput } : {}),
        },
        top_provider: {
          ...(contextLength !== undefined ? { context_length: contextLength } : {}),
          ...(maxCompletionTokens !== undefined ? { max_completion_tokens: maxCompletionTokens } : {}),
        },
      };
      this.modelDetailsCache.set(id, { expires: this.now() + this.ttlMs, model });
    }
    return this.modelDetailsCache.get(id)?.model;
  }

  async image(id: string, refresh = false): Promise<ImageModel> {
    const model = (await this.images(refresh)).find((candidate) => candidate.id === id);
    if (!model)
      throw new AppError(`Modelo de imagem não disponível em /images/models: ${id}`, 'MODEL_UNAVAILABLE');
    return model;
  }

  async video(id: string, refresh = false): Promise<VideoModel> {
    const model = (await this.videos(refresh)).find((candidate) => candidate.id === id);
    if (!model)
      throw new AppError(`Modelo de vídeo não disponível em /videos/models: ${id}`, 'MODEL_UNAVAILABLE');
    return model;
  }

  async imagePricing(model: ImageModel): Promise<unknown> {
    if (!model.endpoints) return undefined;
    const result = await this.client.getImageModelEndpoints(model.endpoints);
    if (!result || typeof result !== 'object' || !('endpoints' in result)) return undefined;
    const endpoints = (result as { endpoints?: unknown }).endpoints;
    return Array.isArray(endpoints)
      ? endpoints.flatMap((item) => {
          if (!item || typeof item !== 'object' || !('pricing' in item)) return [];
          return (item as { pricing?: unknown }).pricing ?? [];
        })
      : undefined;
  }
}
