import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { spawnGit } from './git';

const RECORD_SEPARATOR = 0x1e;
const NUL = 0x00;

export interface GitFileDelta {
  path: Buffer;
  oldPath?: Buffer;
  added: bigint;
  removed: bigint;
  binary: boolean;
}

export interface GitCommitRecord {
  oid: string;
  parentOid: string | null;
  treeOid: string;
  committerTimestamp: number;
  rawAuthor: { name: string; email: string };
  mappedAuthor: { name: string; email: string };
  subject: string;
  files: GitFileDelta[];
}

function readNulField(buffer: Buffer, start: number): { value: Buffer; next: number } {
  const end = buffer.indexOf(NUL, start);
  if (end < 0) throw new Error('Incomplete Git history metadata');
  return { value: buffer.subarray(start, end), next: end + 1 };
}

function parseNumstat(buffer: Buffer, start: number): GitFileDelta[] {
  const files: GitFileDelta[] = [];
  let cursor = start;

  while (cursor < buffer.length) {
    while (buffer[cursor] === 0x0a || buffer[cursor] === 0x0d) cursor += 1;
    if (cursor >= buffer.length) break;
    const token = readNulField(buffer, cursor);
    cursor = token.next;
    const firstTab = token.value.indexOf(0x09);
    const secondTab = firstTab < 0 ? -1 : token.value.indexOf(0x09, firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;

    const addedText = token.value.subarray(0, firstTab).toString('ascii');
    const removedText = token.value.subarray(firstTab + 1, secondTab).toString('ascii');
    let path = token.value.subarray(secondTab + 1);
    let oldPath: Buffer | undefined;

    if (path.length === 0) {
      const oldField = readNulField(buffer, cursor);
      const newField = readNulField(buffer, oldField.next);
      oldPath = Buffer.from(oldField.value);
      path = newField.value;
      cursor = newField.next;
    }

    const binary = addedText === '-' || removedText === '-';
    files.push({
      path: Buffer.from(path),
      ...(oldPath ? { oldPath } : {}),
      added: binary ? 0n : BigInt(addedText),
      removed: binary ? 0n : BigInt(removedText),
      binary,
    });
  }
  return files;
}

export function parseCommitChunk(chunk: Buffer): GitCommitRecord {
  let cursor = chunk[0] === RECORD_SEPARATOR ? 1 : 0;
  const fields: Buffer[] = [];
  for (let index = 0; index < 9; index += 1) {
    const field = readNulField(chunk, cursor);
    fields.push(field.value);
    cursor = field.next;
  }

  const [oid, parents, tree, timestamp, rawName, rawEmail, mappedName, mappedEmail, subject] = fields;
  if (!oid || !parents || !tree || !timestamp || !rawName || !rawEmail || !mappedName || !mappedEmail || !subject) {
    throw new Error('Git history record is missing metadata');
  }
  const parentList = parents.toString('ascii').trim().split(/\s+/).filter(Boolean);
  if (parentList.length > 1) throw new Error('Merge commit unexpectedly reached the non-merge parser');
  const committerTimestamp = Number(timestamp.toString('ascii'));
  if (!Number.isSafeInteger(committerTimestamp)) throw new Error('Invalid Git committer timestamp');

  return {
    oid: oid.toString('ascii'),
    parentOid: parentList[0] ?? null,
    treeOid: tree.toString('ascii'),
    committerTimestamp,
    rawAuthor: { name: rawName.toString('utf8'), email: rawEmail.toString('utf8') },
    mappedAuthor: { name: mappedName.toString('utf8'), email: mappedEmail.toString('utf8') },
    subject: subject.toString('utf8'),
    files: parseNumstat(chunk, cursor),
  };
}

async function waitForSuccess(child: ChildProcessWithoutNullStreams, stderr: Buffer[]): Promise<void> {
  const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
  if (code !== 0) {
    const message = Buffer.concat(stderr).toString('utf8').slice(0, 4_000).trim();
    throw new Error(signal ? `Git history process ended with ${signal}` : message || 'Git history process failed');
  }
}

export async function* streamHistory(
  repositoryPath: string,
  referenceOid: string,
  useReferenceMailmap: boolean,
): AsyncGenerator<GitCommitRecord> {
  const mailmapArgs = useReferenceMailmap
    ? ['-c', 'mailmap.file=/dev/null', '-c', `mailmap.blob=${referenceOid}:.mailmap`]
    : [];
  const format = '%x1e%H%x00%P%x00%T%x00%ct%x00%an%x00%ae%x00%aN%x00%aE%x00%s%x00';
  const child = spawnGit([
    ...mailmapArgs,
    '-C',
    repositoryPath,
    'log',
    referenceOid,
    '--no-merges',
    '--root',
    '--topo-order',
    '--no-color',
    '--no-ext-diff',
    // Submodule (gitlink) pointer changes are intentionally kept so that Git's
    // own numstat reports them as one-line changes, matching the supplied
    // golden fixtures. Submodule contents are never recursed into.
    '--find-renames=50%',
    '--numstat',
    '-z',
    `--format=${format}`,
  ]);
  child.stdin.end();
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= 1024 * 1024) stderr.push(chunk);
  });
  const completion = waitForSuccess(child, stderr);

  let pending = Buffer.alloc(0);
  for await (const value of child.stdout) {
    const chunk = Buffer.from(value as Uint8Array);
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let next = pending.indexOf(RECORD_SEPARATOR, 1);
    while (next >= 0) {
      yield parseCommitChunk(pending.subarray(0, next));
      pending = pending.subarray(next);
      next = pending.indexOf(RECORD_SEPARATOR, 1);
    }
  }
  if (pending.length > 0) yield parseCommitChunk(pending);
  await completion;
}
