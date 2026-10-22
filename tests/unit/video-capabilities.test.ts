import { describe, expect, it } from 'vitest';
import { resolveGenerateAudio, videoAudioCapability } from '../../src/services/video-capabilities.js';

describe('video audio capability policy', () => {
  it('does not treat a catalog false as a guarantee of silent output', () => {
    const model = { id: 'example/provider-managed-video', generate_audio: false };
    expect(videoAudioCapability(model)).toMatchObject({
      mode: 'provider_managed',
      configurable: false,
      canDisable: false,
      catalogValue: false,
    });
    expect(() => resolveGenerateAudio(model, false)).toThrow(/não declara controlo configurável/);
  });

  it('keeps an omitted audio parameter distinct from explicit values', () => {
    const model = { id: 'google/veo-3.1', generate_audio: true };
    expect(resolveGenerateAudio(model, undefined)).toBeUndefined();
    expect(resolveGenerateAudio(model, true)).toBe(true);
    expect(resolveGenerateAudio(model, false)).toBe(false);
  });

  it('describes HeyGen as always-on and gives an actionable error for false', () => {
    const model = { id: 'heygen/heygen-video-1', name: 'HeyGen Video', generate_audio: false };
    expect(videoAudioCapability(model)).toMatchObject({
      mode: 'always_on',
      configurable: false,
      canDisable: false,
      catalogValue: false,
    });
    expect(() => resolveGenerateAudio(model, false)).toThrow(/exige áudio/);
    expect(resolveGenerateAudio(model, undefined)).toBeUndefined();
    expect(resolveGenerateAudio(model, true)).toBe(true);
  });
});
