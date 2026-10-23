export interface ImageModel {
  id: string;
  name?: string;
  description?: string;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: Record<string, unknown>;
  endpoints?: string;
  [key: string]: unknown;
}

export interface OpenRouterModelDetails {
  id: string;
  context_length?: number;
  pricing?: Record<string, unknown>;
  top_provider?: { context_length?: number; max_completion_tokens?: number };
  [key: string]: unknown;
}

export interface VideoModel {
  id: string;
  name?: string;
  description?: string;
  supported_resolutions?: string[] | null;
  supported_aspect_ratios?: string[] | null;
  supported_sizes?: string[] | null;
  supported_durations?: number[] | null;
  supported_frame_images?: string[] | null;
  generate_audio?: boolean | null;
  seed?: boolean | null;
  pricing_skus?: Record<string, string> | null;
  allowed_passthrough_parameters?: string[];
  [key: string]: unknown;
}

export interface ImageGenerationResponse {
  data?: Array<{ b64_json?: string; media_type?: string; revised_prompt?: string }>;
  usage?: { cost?: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface VideoJobResponse {
  id?: string;
  status?: string;
  polling_url?: string;
  generation_id?: string;
  unsigned_urls?: string[];
  usage?: { cost?: number; [key: string]: unknown };
  error?: string;
  [key: string]: unknown;
}

export interface OpenRouterImageRequest {
  model: string;
  prompt: string;
  n?: number;
  aspect_ratio?: string;
  resolution?: string;
  size?: string;
  input_references?: Array<{ type: 'image_url'; image_url: { url: string } }>;
}

export interface OpenRouterVideoRequest {
  model: string;
  prompt: string;
  duration?: number;
  resolution?: string;
  aspect_ratio?: string;
  size?: string;
  generate_audio?: boolean;
  frame_images?: Array<{
    type: 'image_url';
    image_url: { url: string };
    frame_type: 'first_frame' | 'last_frame';
  }>;
}
