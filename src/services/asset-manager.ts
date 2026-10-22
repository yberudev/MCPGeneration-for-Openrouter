import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { VIDEO_MIME_EXTENSIONS } from '../config/defaults.js';
import type { AppConfig } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import type { MetadataStore } from './metadata-store.js';
import { type AssetRecord } from './metadata-store.js';

export interface ImageInfo {
  mimeType: string;
  extension: string;
  width?: number;
  height?: number;
}
export interface SavedAsset extends AssetRecord {
  absolutePath: string;
}

function dimensionsFromJpeg(bytes: Buffer): { width?: number; height?: number } {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) break;
    if (
      marker &&
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)
    ) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return {};
}

export function detectImage(bytes: Buffer): ImageInfo {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return {
      mimeType: 'image/png',
      extension: '.png',
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: '.jpg', ...dimensionsFromJpeg(bytes) };
  }
  if (
    bytes.length >= 30 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      return {
        mimeType: 'image/webp',
        extension: '.webp',
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      };
    }
    return { mimeType: 'image/webp', extension: '.webp' };
  }
  throw new AppError('O ficheiro não contém uma imagem PNG, JPEG ou WebP válida.', 'INVALID_IMAGE_FORMAT');
}

function assertWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeBasename(filename: string | undefined, fallback: string, extension: string): string {
  const candidate = filename?.trim() || fallback;
  if (
    candidate !== basename(candidate) ||
    candidate.includes('\0') ||
    candidate === '.' ||
    candidate === '..'
  ) {
    throw new AppError('O nome de ficheiro deve ser um único nome, sem diretórios.', 'INVALID_FILENAME');
  }
  const withoutControls = Array.from(candidate)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join('');
  const stem =
    parse(withoutControls)
      .name.replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, '-')
      .slice(0, 120) || fallback;
  return `${stem}${extension}`;
}

export class AssetManager {
  constructor(
    private readonly config: AppConfig,
    private readonly store: MetadataStore,
  ) {}

  private async canonicalRoots(): Promise<string[]> {
    const roots: string[] = [];
    for (const root of this.config.allowedRoots) {
      try {
        const canonical = await realpath(root);
        if ((await stat(canonical)).isDirectory()) roots.push(canonical);
      } catch {
        /* An unavailable root cannot authorize a write. */
      }
    }
    return roots;
  }

  private async authorizePath(path: string): Promise<{ root: string; path: string }> {
    const resolved = resolve(path);
    const roots = await this.canonicalRoots();
    const root = roots
      .filter((candidate) => assertWithin(resolved, candidate))
      .sort((a, b) => b.length - a.length)[0];
    if (!root)
      throw new AppError(
        'O caminho pedido não está dentro de uma raiz autorizada. Configure YBERU_PROJECT_ROOT ou YBERU_ALLOWED_ROOTS.',
        'PATH_NOT_ALLOWED',
      );
    return { root, path: resolved };
  }

  private async checkNoSymlink(path: string, root: string, create: boolean): Promise<void> {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
      throw new AppError('A raiz autorizada não é um diretório seguro.', 'UNSAFE_ROOT');
    const rel = relative(root, path);
    if (!assertWithin(path, root))
      throw new AppError('Tentativa de sair da raiz autorizada.', 'PATH_NOT_ALLOWED');
    let cursor = root;
    for (const segment of rel.split(sep).filter(Boolean)) {
      cursor = join(cursor, segment);
      try {
        const info = await lstat(cursor);
        if (info.isSymbolicLink())
          throw new AppError('Diretórios de saída com symlinks não são permitidos.', 'SYMLINK_NOT_ALLOWED');
        if (!info.isDirectory())
          throw new AppError(
            'O caminho de saída contém um componente que não é diretório.',
            'INVALID_OUTPUT_DIR',
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (create) await mkdir(cursor, { mode: 0o700 });
        else throw new AppError('O diretório de saída não existe.', 'OUTPUT_DIR_NOT_FOUND');
      }
    }
  }

  async outputDirectory(
    outputDir: string | undefined,
    kind: 'image' | 'video',
  ): Promise<{ root: string; directory: string }> {
    const baseRoot = this.config.projectRoot;
    let target: string;
    if (outputDir && isAbsolute(outputDir)) target = resolve(outputDir);
    else {
      if (!baseRoot)
        throw new AppError(
          'Não foi possível determinar o projeto. Defina YBERU_PROJECT_ROOT ou use Claude Code com CLAUDE_PROJECT_DIR.',
          'MISSING_PROJECT_ROOT',
        );
      const subdir = outputDir ?? join(this.config.assetsDir, kind === 'image' ? 'images' : 'videos');
      target = resolve(baseRoot, subdir);
    }
    const authorization = await this.authorizePath(target);
    await this.checkNoSymlink(authorization.path, authorization.root, true);
    return { root: authorization.root, directory: authorization.path };
  }

  async readInputImage(
    path: string,
  ): Promise<{ bytes: Buffer; info: ImageInfo; dataUrl: string; absolutePath: string }> {
    const resolved = resolve(path);
    const { root } = await this.authorizePath(resolved);
    const canonical = await realpath(resolved);
    if (!assertWithin(canonical, root))
      throw new AppError(
        'A imagem de entrada sai da raiz autorizada através de um symlink.',
        'SYMLINK_NOT_ALLOWED',
      );
    const info = await lstat(resolved);
    if (info.isSymbolicLink() || !info.isFile())
      throw new AppError(
        'A imagem de entrada deve ser um ficheiro normal, sem symlink.',
        'INVALID_INPUT_IMAGE',
      );
    if (info.size > this.config.maxImageBytes)
      throw new AppError(
        `A imagem excede o limite de ${this.config.maxImageBytes} bytes.`,
        'IMAGE_TOO_LARGE',
      );
    const bytes = await readFile(resolved);
    const detected = detectImage(bytes);
    return {
      bytes,
      info: detected,
      dataUrl: `data:${detected.mimeType};base64,${bytes.toString('base64')}`,
      absolutePath: canonical,
    };
  }

  private async availablePath(directory: string, name: string): Promise<string> {
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.F_OK);
    } catch {
      return candidate;
    }
    const ext = extname(name);
    const stem = name.slice(0, -ext.length);
    for (let i = 2; i < 100_000; i += 1) {
      const next = join(directory, `${stem}-${i}${ext}`);
      try {
        await access(next, constants.F_OK);
      } catch {
        return next;
      }
    }
    throw new AppError('Não foi possível reservar um nome de ficheiro livre.', 'FILENAME_EXHAUSTED');
  }

  private async finalize(tempPath: string, directory: string, requestedName: string): Promise<string> {
    const ext = extname(requestedName);
    const stem = requestedName.slice(0, -ext.length);
    for (let i = 1; i < 100_000; i += 1) {
      const candidate = join(directory, i === 1 ? requestedName : `${stem}-${i}${ext}`);
      try {
        await link(tempPath, candidate);
        await unlink(tempPath);
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
    }
    throw new AppError(
      'Não foi possível concluir a gravação sem sobrescrever outro ficheiro.',
      'FILENAME_EXHAUSTED',
    );
  }

  async saveImage(args: {
    bytes: Buffer;
    filename?: string;
    outputDir?: string;
    model: string;
    prompt: string;
    costUsd: number | null;
    parameters?: Record<string, unknown>;
    relatedAssetId?: string;
    relatedAssetPath?: string;
    generationId?: string;
  }): Promise<SavedAsset> {
    if (args.bytes.length > this.config.maxImageBytes)
      throw new AppError('A imagem devolvida excede o limite configurado.', 'IMAGE_TOO_LARGE');
    const info = detectImage(args.bytes);
    const { root, directory } = await this.outputDirectory(args.outputDir, 'image');
    const name = safeBasename(
      args.filename,
      `image-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      info.extension,
    );
    const destination = await this.availablePath(directory, name);
    const temp = join(directory, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, args.bytes, { flag: 'wx', mode: 0o600 });
      const finalPath = await this.finalize(temp, directory, basename(destination));
      const asset: AssetRecord = {
        id: randomUUID(),
        type: 'image',
        path: finalPath,
        root,
        relativePath: relative(root, finalPath),
        name: basename(finalPath),
        mimeType: info.mimeType,
        sizeBytes: args.bytes.length,
        status: 'completed',
        ...(info.width ? { width: info.width, height: info.height } : {}),
        model: args.model,
        prompt: args.prompt,
        createdAt: new Date().toISOString(),
        costUsd: args.costUsd,
        ...(args.generationId ? { generationId: args.generationId } : {}),
        ...(args.relatedAssetId ? { relatedAssetId: args.relatedAssetId } : {}),
        ...(args.relatedAssetPath ? { relatedAssetPath: args.relatedAssetPath } : {}),
        ...(args.parameters ? { parameters: args.parameters } : {}),
      };
      await this.store.saveAsset(asset);
      return {
        ...asset,
        absolutePath: finalPath,
        ...(info.width
          ? { parameters: { ...asset.parameters, width: info.width, height: info.height } }
          : {}),
      };
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async saveVideoResponse(args: {
    response: Response;
    filename?: string;
    outputDir?: string;
    model: string;
    prompt: string;
    costUsd: number | null;
    jobId: string;
    parameters?: Record<string, unknown>;
  }): Promise<SavedAsset> {
    const contentType =
      args.response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    const extension = VIDEO_MIME_EXTENSIONS[contentType];
    if (!extension || !args.response.body)
      throw new AppError(
        `Formato de vídeo não suportado: ${contentType || 'desconhecido'}.`,
        'INVALID_VIDEO_FORMAT',
      );
    const contentLength = Number(args.response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > this.config.maxVideoBytes)
      throw new AppError('O vídeo excede o limite configurado.', 'VIDEO_TOO_LARGE');
    const { root, directory } = await this.outputDirectory(args.outputDir, 'video');
    const name = safeBasename(args.filename, `video-${args.jobId}`, extension);
    const temp = join(directory, `.${randomUUID()}.download`);
    const file = await open(temp, 'wx', 0o600);
    let sizeBytes = 0;
    try {
      const reader = args.response.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        sizeBytes += chunk.value.byteLength;
        if (sizeBytes > this.config.maxVideoBytes) {
          await reader.cancel();
          throw new AppError(
            'O vídeo excedeu o limite de tamanho durante a transferência.',
            'VIDEO_TOO_LARGE',
          );
        }
        await file.writeFile(chunk.value);
      }
      await file.sync();
      await file.close();
      if (sizeBytes < 16)
        throw new AppError('O ficheiro de vídeo está vazio ou incompleto.', 'INVALID_VIDEO_FILE');
      const handle = await open(temp, 'r');
      const header = Buffer.alloc(16);
      await handle.read(header, 0, 16, 0);
      await handle.close();
      const valid =
        contentType === 'video/mp4'
          ? header.toString('ascii', 4, 8) === 'ftyp'
          : header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
      if (!valid)
        throw new AppError(
          'A assinatura do ficheiro não corresponde ao tipo de vídeo recebido.',
          'INVALID_VIDEO_FILE',
        );
      const finalPath = await this.finalize(temp, directory, name);
      const asset: AssetRecord = {
        id: randomUUID(),
        type: 'video',
        path: finalPath,
        root,
        relativePath: relative(root, finalPath),
        name: basename(finalPath),
        mimeType: contentType,
        sizeBytes,
        status: 'completed',
        model: args.model,
        prompt: args.prompt,
        createdAt: new Date().toISOString(),
        costUsd: args.costUsd,
        jobId: args.jobId,
        generationId: args.jobId,
        ...(args.parameters ? { parameters: args.parameters } : {}),
      };
      await this.store.saveAsset(asset);
      return { ...asset, absolutePath: finalPath };
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async list(type: 'image' | 'video' | 'all', limit: number, projectRoot?: string): Promise<AssetRecord[]> {
    let selectedRoot: string | undefined;
    if (projectRoot) selectedRoot = (await this.authorizePath(resolve(projectRoot))).root;
    const all = await this.store.assets();
    return all
      .filter(
        (asset) => (type === 'all' || asset.type === type) && (!selectedRoot || asset.root === selectedRoot),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async exists(path: string): Promise<boolean> {
    try {
      const info = await lstat(path);
      return !info.isSymbolicLink() && info.isFile() && info.size > 0;
    } catch {
      return false;
    }
  }
}
