import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { AssetManager, detectImage } from '../../src/services/asset-manager.js';
import { MetadataStore } from '../../src/services/metadata-store.js';

const png = () => {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(64, 16);
  bytes.writeUInt32BE(32, 20);
  return bytes;
};

describe('AssetManager', () => {
  it('detects PNG, JPEG and WebP signatures', () => {
    expect(detectImage(png()).mimeType).toBe('image/png');
    expect(detectImage(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])).mimeType).toBe(
      'image/jpeg',
    );
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0);
    webp.write('WEBP', 8);
    webp.write('VP8X', 12);
    expect(detectImage(webp).mimeType).toBe('image/webp');
  });

  it('blocks path traversal and symlink output directories', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'mcp-assets-'));
    const root = join(parent, 'project');
    const outside = join(parent, 'outside');
    await mkdir(root);
    await mkdir(outside);
    const store = new MetadataStore(join(parent, 'data'));
    await store.init();
    const config = loadConfig({ YBERU_PROJECT_ROOT: root, YBERU_DATA_DIR: join(parent, 'data') });
    const manager = new AssetManager(config, store);
    await expect(manager.outputDirectory('../outside', 'image')).rejects.toThrow('raiz autorizada');
    await symlink(outside, join(root, 'linked'));
    await expect(manager.outputDirectory('linked/new', 'image')).rejects.toThrow('symlinks');
  });

  it('writes images atomically with the detected extension and avoids overwrites', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'mcp-assets-'));
    const root = join(parent, 'project');
    await mkdir(root);
    const store = new MetadataStore(join(parent, 'data'));
    await store.init();
    const manager = new AssetManager(loadConfig({ YBERU_PROJECT_ROOT: root }), store);
    const one = await manager.saveImage({
      bytes: png(),
      filename: 'mascot.jpg',
      model: 'mock/model',
      prompt: 'fox',
      costUsd: 0.02,
    });
    const two = await manager.saveImage({
      bytes: png(),
      filename: 'mascot.jpg',
      model: 'mock/model',
      prompt: 'fox',
      costUsd: null,
    });
    expect(one.path).toMatch(/mascot\.png$/);
    expect(two.path).toMatch(/mascot-2\.png$/);
    expect((await store.assets()).length).toBe(2);
    await writeFile(join(root, 'not-image.png'), Buffer.from('x'));
  });
});
