import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveRef, runGit, validateRemoteUrl } from './git';
import { validateGitMarker } from './archive';

const temporary: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('validateRemoteUrl SSRF and scheme protection', () => {
  const rejected = [
    ['non-HTTPS scheme', 'http://8.8.8.8/owner/repo.git'],
    ['embedded credentials', 'https://user:secret@8.8.8.8/owner/repo.git'],
    ['non-standard port', 'https://8.8.8.8:8443/owner/repo.git'],
    ['loopback address', 'https://127.0.0.1/owner/repo.git'],
    ['private network address', 'https://10.0.0.5/owner/repo.git'],
    ['cloud metadata link-local address', 'https://169.254.169.254/latest/meta-data/'],
    ['malformed URL', 'not a repository url'],
  ] as const;

  for (const [label, url] of rejected) {
    it(`rejects ${label}`, async () => {
      await expect(validateRemoteUrl(url)).rejects.toThrow();
    });
  }

  it('accepts a public HTTPS URL and strips the fragment', async () => {
    const result = await validateRemoteUrl('https://8.8.8.8/owner/repo.git#readme');
    expect(result.url).toBe('https://8.8.8.8/owner/repo.git');
    expect(result.safeDisplayUrl).toBe(result.url);
  });
});

describe('validateGitMarker pointer safety', () => {
  it('accepts a .git directory', async () => {
    const root = await makeTempDir('rat-gitdir-');
    const repository = join(root, 'repo');
    await mkdir(join(repository, '.git'), { recursive: true });
    await expect(validateGitMarker(repository, root)).resolves.toBeUndefined();
  });

  it('accepts a .git file pointing inside the extraction root', async () => {
    const root = await makeTempDir('rat-gitfile-');
    const realGitDir = join(root, 'real-git');
    await mkdir(realGitDir, { recursive: true });
    const repository = join(root, 'repo');
    await mkdir(repository, { recursive: true });
    await writeFile(join(repository, '.git'), 'gitdir: ../real-git\n');
    await expect(validateGitMarker(repository, root)).resolves.toBeUndefined();
  });

  it('rejects a .git file pointing outside the extraction root', async () => {
    const base = await makeTempDir('rat-escape-');
    const root = join(base, 'extract');
    const outside = join(base, 'outside');
    await mkdir(outside, { recursive: true });
    const repository = join(root, 'repo');
    await mkdir(repository, { recursive: true });
    await writeFile(join(repository, '.git'), 'gitdir: ../../outside\n');
    await expect(validateGitMarker(repository, root)).rejects.toThrow(/outside/i);
  });

  it('rejects a malformed .git file', async () => {
    const root = await makeTempDir('rat-malformed-');
    const repository = join(root, 'repo');
    await mkdir(repository, { recursive: true });
    await writeFile(join(repository, '.git'), 'this is not a gitdir pointer\n');
    await expect(validateGitMarker(repository, root)).rejects.toThrow(/malformed/i);
  });
});

describe('Git process hardening', () => {
  it('never executes shell metacharacters injected through a ref', async () => {
    const repository = await makeTempDir('rat-inject-');
    await runGit(['init', repository]);
    const marker = join(tmpdir(), `rat-injection-${Date.now()}-${process.pid}`);
    await expect(resolveRef(repository, `HEAD; touch ${marker}`)).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
  });

  it('aborts when command output exceeds the configured byte cap', async () => {
    await expect(runGit(['--version'], { maxOutputBytes: 8 })).rejects.toThrow(/exceeded/i);
  });
});
