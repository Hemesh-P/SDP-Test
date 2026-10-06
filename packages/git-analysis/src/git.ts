import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import ipaddr from 'ipaddr.js';

export interface GitOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface RepositoryRef {
  name: string;
  oid: string;
  kind: 'branch' | 'tag' | 'remote' | 'other';
}

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

const BASE_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  LC_ALL: 'C.UTF-8',
};

export function spawnGit(args: readonly string[], options: GitOptions = {}): ChildProcessWithoutNullStreams {
  return spawn('git', [...args], {
    cwd: options.cwd,
    env: { ...BASE_GIT_ENV, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

export async function runGit(args: readonly string[], options: GitOptions = {}): Promise<Buffer> {
  const child = spawnGit(args, options);
  child.stdin.end();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const maxOutput = options.maxOutputBytes ?? 32 * 1024 * 1024;

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= maxOutput) stdout.push(chunk);
    else child.kill('SIGTERM');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= 1024 * 1024) stderr.push(chunk);
  });

  const timeout = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs ?? 60_000);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timeout));

  const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
  if (stdoutBytes > maxOutput) throw new GitCommandError('Git output exceeded the configured limit', result.code, errorOutput);
  if (result.code !== 0) {
    throw new GitCommandError(
      result.signal ? `Git was terminated by ${result.signal}` : 'Git command failed',
      result.code,
      errorOutput.slice(0, 4_000),
    );
  }
  return Buffer.concat(stdout);
}

function isPublicAddress(address: string): boolean {
  const parsed = ipaddr.parse(address);
  const range = parsed.range();
  return range === 'unicast';
}

export async function validateRemoteUrl(input: string): Promise<{ url: string; safeDisplayUrl: string }> {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Repository URL is not valid');
  }
  if (parsed.protocol !== 'https:') throw new Error('Only public HTTPS repository URLs are supported');
  if (parsed.username || parsed.password) throw new Error('Credentials must not be embedded in repository URLs');
  if (!parsed.hostname) throw new Error('Repository URL must include a hostname');
  if (parsed.port && parsed.port !== '443') throw new Error('Only the standard HTTPS port is supported');

  const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Repository host must resolve only to public IP addresses');
  }

  parsed.hash = '';
  const safe = parsed.toString();
  return { url: safe, safeDisplayUrl: safe };
}

export async function cloneMirror(url: string, destination: string, timeoutMs: number): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await runGit(
    [
      '-c',
      'protocol.file.allow=never',
      '-c',
      'http.followRedirects=false',
      'clone',
      '--mirror',
      '--no-local',
      '--',
      url,
      destination,
    ],
    { timeoutMs, maxOutputBytes: 4 * 1024 * 1024 },
  );
}

export async function mirrorLocalRepository(
  source: string,
  destination: string,
  timeoutMs: number,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await runGit(['clone', '--mirror', '--no-local', '--', source, destination], {
    timeoutMs,
    maxOutputBytes: 4 * 1024 * 1024,
  });
}

export async function validateRepository(repositoryPath: string): Promise<void> {
  const bare = (await runGit(['-C', repositoryPath, 'rev-parse', '--is-bare-repository'])).toString().trim();
  if (bare !== 'true') throw new Error('Normalized repository is not bare');
  await runGit(['-C', repositoryPath, 'fsck', '--connectivity-only', '--no-dangling'], {
    timeoutMs: 10 * 60_000,
    maxOutputBytes: 4 * 1024 * 1024,
  });
}

export async function resolveRef(repositoryPath: string, ref: string): Promise<string> {
  const oid = (
    await runGit(['-C', repositoryPath, 'rev-parse', '--verify', `${ref}^{commit}`], {
      maxOutputBytes: 1024,
    })
  )
    .toString('ascii')
    .trim();
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(oid)) throw new Error('Git returned an invalid object ID');
  return oid;
}

export async function defaultRef(repositoryPath: string): Promise<string> {
  try {
    return (await runGit(['-C', repositoryPath, 'symbolic-ref', 'HEAD'])).toString().trim();
  } catch {
    return 'HEAD';
  }
}

export async function listRefs(repositoryPath: string): Promise<RepositoryRef[]> {
  const output = await runGit([
    '-C',
    repositoryPath,
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00',
    'refs/heads',
    'refs/tags',
    'refs/remotes',
  ]);
  const fields = output.toString('utf8').split('\0');
  const refs: RepositoryRef[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const name = fields[index]?.replace(/^\n+/, '');
    const oid = fields[index + 1];
    if (!name || !oid) continue;
    const kind = name.startsWith('refs/heads/')
      ? 'branch'
      : name.startsWith('refs/tags/')
        ? 'tag'
        : name.startsWith('refs/remotes/')
          ? 'remote'
          : 'other';
    refs.push({ name, oid, kind });
  }
  return refs;
}

export async function countNonMergeCommits(repositoryPath: string, oid: string): Promise<number> {
  const count = (
    await runGit(['-C', repositoryPath, 'rev-list', '--count', '--no-merges', oid], {
      maxOutputBytes: 1024,
    })
  )
    .toString('ascii')
    .trim();
  const value = Number(count);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Git returned an invalid commit count');
  return value;
}

export async function referenceHasMailmap(repositoryPath: string, oid: string): Promise<boolean> {
  try {
    await runGit(['-C', repositoryPath, 'cat-file', '-e', `${oid}:.mailmap`], { maxOutputBytes: 1024 });
    return true;
  } catch {
    return false;
  }
}
