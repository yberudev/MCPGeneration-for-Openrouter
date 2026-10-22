import { AppError } from '../utils/errors.js';
import type { ImageModel, VideoModel } from '../types/openrouter.js';
import type { OpenRouterClient } from '../providers/openrouter/client.js';

export class ModelRegistry {
  private imageCache?: { expires: number; models: ImageModel[] };
  private videoCache?: { expires: number; models: VideoModel[] };
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
