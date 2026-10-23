#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SECRET_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/mcp-generation"
cd "$REPO_ROOT"
mkdir -p "$SECRET_DIR"
chmod 700 "$SECRET_DIR"

node --input-type=module - "$REPO_ROOT/.env" "$SECRET_DIR/worker.env" "$SECRET_DIR" <<'NODE'
import { open, readFile, rename, copyFile, chmod, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse } from 'dotenv';

const [sourcePath, targetPath, secretDir] = process.argv.slice(2);
let sourceText = '';
let targetText = '';
try { sourceText = await readFile(sourcePath, 'utf8'); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
try { targetText = await readFile(targetPath, 'utf8'); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const sourceKey = parse(sourceText).OPENROUTER_API_KEY;
const targetKey = parse(targetText).OPENROUTER_API_KEY;
if (!sourceKey && !targetKey) {
  process.stderr.write('No OPENROUTER_API_KEY found in the repository .env or external worker.env.\n');
  process.exit(1);
}
if (!targetKey && sourceKey) {
  const suffix = targetText && !targetText.endsWith('\n') ? '\n' : '';
  targetText = `${targetText}${suffix}OPENROUTER_API_KEY=${JSON.stringify(sourceKey)}\n`;
  const temp = `${targetPath}.${process.pid}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(targetText, 'utf8');
    await file.sync();
  } finally { await file.close(); }
  await rename(temp, targetPath);
  const dir = await open(dirname(targetPath), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
  await chmod(targetPath, 0o600);
}
if (targetKey || sourceKey) await chmod(targetPath, 0o600);
if (sourceKey) {
  const backupDir = join(secretDir, `env-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(backupDir, { mode: 0o700 });
  const backupPath = join(backupDir, '.env');
  await copyFile(sourcePath, backupPath);
  await chmod(backupPath, 0o600);
  const withoutKey = sourceText
    .split(/(?<=\n)/)
    .filter((line) => !/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=/.test(line))
    .join('');
  const temp = `${sourcePath}.${process.pid}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(withoutKey, 'utf8');
    await file.sync();
  } finally { await file.close(); }
  await rename(temp, sourcePath);
  const dir = await open(dirname(sourcePath), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
  await chmod(sourcePath, 0o600);
  process.stdout.write(`Moved the API key to the external config; original .env backup: ${backupPath}\n`);
} else {
  process.stdout.write('External worker.env already contains the API key; repository .env was left unchanged.\n');
}
NODE
