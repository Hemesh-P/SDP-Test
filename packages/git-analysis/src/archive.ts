import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import unzipper from 'unzipper';

export interface ArchiveLimits {
  maxEntries: number;
  maxExtractedBytes: number;
  maxDepth?: number;
}

function safeArchivePath(root: string, archivePath: string): string {
  const normalized = posix.normalize(archivePath.replaceAll('\\', '/'));
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    posix.isAbsolute(normalized) ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    throw new Error(`Archive contains an unsafe path: ${archivePath.slice(0, 200)}`);
  }
  const destination = resolve(root, ...normalized.split('/'));
  const relationship = relative(root, destination);
  if (relationship.startsWith(`..${sep}`) || relationship === '..' || isAbsolute(relationship)) {
    throw new Error('Archive entry escapes the extraction directory');
  }
  return destination;
}

export async function extractRepositoryArchive(
  archivePath: string,
  extractionRoot: string,
  limits: ArchiveLimits,
): Promise<void> {
  const archive = await unzipper.Open.file(archivePath);
  if (archive.files.length > limits.maxEntries) {
    throw new Error(`Archive exceeds the ${limits.maxEntries.toLocaleString()} entry limit`);
  }

  let declaredBytes = 0;
  for (const entry of archive.files) {
    declaredBytes += entry.uncompressedSize;
    if (declaredBytes > limits.maxExtractedBytes) {
      throw new Error('Archive exceeds the extracted-size limit');
    }
    if (entry.type !== 'File' && entry.type !== 'Directory') {
      throw new Error('Archive links and special entries are not supported');
    }
  }

  await mkdir(extractionRoot, { recursive: true, mode: 0o700 });
  let writtenBytes = 0;
  for (const entry of archive.files) {
    const destination = safeArchivePath(extractionRoot, entry.path);
    if (entry.type === 'Directory') {
      await mkdir(destination, { recursive: true, mode: 0o700 });
      continue;
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const stream = entry.stream();
    stream.on('data', (chunk: Buffer) => {
      writtenBytes += chunk.length;
      if (writtenBytes > limits.maxExtractedBytes) stream.destroy(new Error('Extracted-size limit exceeded'));
    });
    await pipeline(stream, createWriteStream(destination, { mode: 0o600, flags: 'wx' }));
  }
}

async function walkForGitMarkers(
  root: string,
  current: string,
  depth: number,
  maxDepth: number,
  found: string[],
): Promise<void> {
  if (depth > maxDepth) return;
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git' && (entry.isDirectory() || entry.isFile())) {
      found.push(current);
      continue;
    }
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      const child = resolve(current, entry.name);
      const relationship = relative(root, child);
      if (!relationship.startsWith('..')) await walkForGitMarkers(root, child, depth + 1, maxDepth, found);
    }
  }
}

export async function discoverRepositories(extractionRoot: string, maxDepth = 6): Promise<string[]> {
  const found: string[] = [];
  await walkForGitMarkers(extractionRoot, extractionRoot, 0, maxDepth, found);
  return [...new Set(found)].sort();
}

export async function validateGitMarker(repositoryRoot: string, extractionRoot: string): Promise<void> {
  const marker = resolve(repositoryRoot, '.git');
  const stat = await lstat(marker);
  if (stat.isDirectory()) return;
  if (!stat.isFile()) throw new Error('.git marker must be a regular file or directory');

  const content = (await readFile(marker, 'utf8')).trim();
  const match = /^gitdir:\s*(.+)$/i.exec(content);
  if (!match?.[1]) throw new Error('The .git file is malformed');
  const target = resolve(repositoryRoot, match[1]);
  const canonicalRoot = await realpath(extractionRoot);
  const canonicalTarget = await realpath(target);
  const relationship = relative(canonicalRoot, canonicalTarget);
  if (relationship === '..' || relationship.startsWith(`..${sep}`) || isAbsolute(relationship)) {
    throw new Error('The .git file points outside the uploaded archive');
  }
  const targetStat = await lstat(canonicalTarget);
  if (!targetStat.isDirectory()) throw new Error('The .git file does not point to a directory');
}
