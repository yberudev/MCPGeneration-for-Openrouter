import * as z from 'zod/v4';

const imageModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    architecture: z
      .object({
        input_modalities: z.array(z.string()).optional(),
        output_modalities: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    supported_parameters: z.record(z.string(), z.unknown()).optional(),
    endpoints: z.string().optional(),
  })
  .passthrough();

const videoModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    supported_resolutions: z.array(z.string()).nullable().optional(),
    supported_aspect_ratios: z.array(z.string()).nullable().optional(),
    supported_sizes: z.array(z.string()).nullable().optional(),
    supported_durations: z.array(z.number()).nullable().optional(),
    supported_frame_images: z.array(z.string()).nullable().optional(),
    generate_audio: z.boolean().nullable().optional(),
    seed: z.boolean().nullable().optional(),
    pricing_skus: z.record(z.string(), z.string()).nullable().optional(),
    allowed_passthrough_parameters: z.array(z.string()).optional(),
  })
  .passthrough();

export const imageModelsResponseSchema = z.object({ data: z.array(imageModelSchema) }).passthrough();
export const videoModelsResponseSchema = z.object({ data: z.array(videoModelSchema) }).passthrough();

export const imageGenerationResponseSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            b64_json: z.string().optional(),
            media_type: z.string().optional(),
            revised_prompt: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    usage: z.object({ cost: z.number().nonnegative().optional() }).passthrough().optional(),
  })
  .passthrough();

export const videoJobResponseSchema = z
  .object({
    id: z.string().optional(),
    status: z.string().optional(),
    polling_url: z.string().optional(),
    generation_id: z.string().optional(),
    unsigned_urls: z.array(z.string()).optional(),
    usage: z.object({ cost: z.number().nonnegative().optional() }).passthrough().optional(),
    error: z.string().optional(),
  })
  .passthrough();
