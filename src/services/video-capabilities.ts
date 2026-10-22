import { AppError } from '../utils/errors.js';
import type { VideoModel } from '../types/openrouter.js';

export type VideoAudioMode = 'always_on' | 'configurable' | 'provider_managed';

export interface VideoAudioCapability {
  mode: VideoAudioMode;
  configurable: boolean;
  canDisable: boolean;
  catalogValue: boolean | null;
  note: string;
}

// HeyGen publishes generate_audio=false as catalog metadata, but its video
// endpoint always renders audio and rejects an explicit false in the request.
const ALWAYS_AUDIO_MODELS = new Set(['heygen/heygen-video-1']);

export function videoAudioCapability(model: VideoModel): VideoAudioCapability {
  const catalogValue = model.generate_audio ?? null;
  if (ALWAYS_AUDIO_MODELS.has(model.id)) {
    return {
      mode: 'always_on',
      configurable: false,
      canDisable: false,
      catalogValue,
      note: 'O fornecedor gera sempre uma faixa de áudio; omita generate_audio.',
    };
  }
  if (model.generate_audio === true) {
    return {
      mode: 'configurable',
      configurable: true,
      canDisable: true,
      catalogValue,
      note: 'O modelo anuncia controlo de áudio; true/false são enviados quando especificados.',
    };
  }
  return {
    mode: 'provider_managed',
    configurable: false,
    canDisable: false,
    catalogValue,
    note: 'O catálogo não anuncia controlo configurável; false não garante saída silenciosa.',
  };
}

export function resolveGenerateAudio(model: VideoModel, requested: boolean | undefined): boolean | undefined {
  if (requested === undefined) return undefined;
  const capability = videoAudioCapability(model);
  if (capability.mode === 'always_on' && requested === false) {
    throw new AppError(
      `${model.name ?? model.id} exige áudio e rejeita generate_audio: false. Omita generate_audio para deixar o fornecedor aplicar o comportamento do modelo.`,
      'VIDEO_AUDIO_REQUIRED',
    );
  }
  if (capability.mode === 'configurable') return requested;
  if (capability.mode === 'always_on' && requested === true) return true;
  throw new AppError(
    `O catálogo não declara controlo configurável de áudio para ${model.id}; omita generate_audio e consulte audio_policy em list_models.`,
    'UNSUPPORTED_VIDEO_AUDIO',
  );
}
