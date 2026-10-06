import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runGit } from './git';
import { streamHistory } from './history';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Raw Author',
      GIT_AUTHOR_EMAIL: 'raw@example.com',
      GIT_COMMITTER_NAME: 'Committer',
      GIT_COMMITTER_EMAIL: 'committer@example.com',
      GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z',
      ...env,
    },
  });
}

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'rat-history-'));
  temporaryDirectories.push(directory);
  await git(directory, ['init', '--initial-branch=main']);
  await writeFile(join(directory, '.mailmap'), 'Mapped Author <mapped@example.com> <raw@example.com>\n');
  await writeFile(join(directory, 'hello world.txt'), 'one\ntwo\n');
  await git(directory, ['add', '.']);
  await git(directory, ['commit', '-m', 'root']);
  await rename(join(directory, 'hello world.txt'), join(directory, 'renamed.txt'));
  await writeFile(join(directory, 'renamed.txt'), 'one\ntwo\nthree\n');
  await git(directory, ['add', '-A']);
  await git(directory, ['commit', '-m', 'rename and edit'], {
    GIT_AUTHOR_DATE: '2024-01-02T00:00:00Z',
    GIT_COMMITTER_DATE: '2024-01-02T00:00:00Z',
  });
  return directory;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Git history stream', () => {
  it('parses root commits, mailmap identities and rename paths', async () => {
    const directory = await fixture();
    const head = (await runGit(['-C', directory, 'rev-parse', 'HEAD'])).toString().trim();
    const commits = [];
    for await (const commit of streamHistory(directory, head, true)) commits.push(commit);

    expect(commits).toHaveLength(2);
    expect(commits[0]?.subject).toBe('rename and edit');
    expect(commits[0]?.mappedAuthor).toEqual({
      name: 'Mapped Author',
      email: 'mapped@example.com',
    });
    expect(commits[0]?.files[0]?.path.toString()).toBe('renamed.txt');
    expect(commits[0]?.files[0]?.oldPath?.toString()).toBe('hello world.txt');
    expect(commits[0]?.files[0]?.added).toBe(1n);
    expect(commits[1]?.parentOid).toBeNull();
    expect(commits[1]?.files.some((file) => file.path.toString() === 'hello world.txt')).toBe(true);
  });
});
