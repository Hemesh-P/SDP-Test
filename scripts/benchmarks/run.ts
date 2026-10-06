import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { referenceHasMailmap, resolveRef, streamHistory } from '@rat/git-analysis';

interface BenchmarkResult {
  commits: number;
  changedFiles: number;
  added: string;
  removed: string;
  churn: string;
  generationSeconds: number;
  analysisSeconds: number;
  peakRssMb: number;
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<void> {
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
  });
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const [code] = (await once(child, 'close')) as [number | null];
  if (code !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed: ${Buffer.concat(stderr).toString('utf8')}`,
    );
}

async function generateRepository(
  commits: number,
): Promise<{ path: string; generationSeconds: number }> {
  const path = await mkdtemp(join(tmpdir(), `rat-benchmark-${commits}-`));
  const started = performance.now();
  await run('git', ['init', '--initial-branch=main'], path);
  await run('git', ['config', 'user.name', 'RAT Benchmark'], path);
  await run('git', ['config', 'user.email', 'benchmark@example.invalid'], path);
  await mkdir(join(path, 'src'), { recursive: true });
  for (let index = 0; index < commits; index += 1) {
    const file = join(path, 'src', `file-${index % 100}.txt`);
    const previous = await readFile(file, 'utf8').catch(() => '');
    await writeFile(file, `${previous}line ${index}\n`);
    const timestamp = new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString();
    await run('git', ['add', 'src'], path);
    await run('git', ['commit', '-m', `benchmark ${index}`], path, {
      GIT_AUTHOR_DATE: timestamp,
      GIT_COMMITTER_DATE: timestamp,
    });
  }
  return { path, generationSeconds: (performance.now() - started) / 1_000 };
}

async function analyze(
  path: string,
): Promise<Omit<BenchmarkResult, 'commits' | 'generationSeconds'>> {
  const head = await resolveRef(path, 'HEAD');
  const useMailmap = await referenceHasMailmap(path, head);
  const started = performance.now();
  let changedFiles = 0;
  let added = 0n;
  let removed = 0n;
  let peakRss = process.memoryUsage().rss;
  for await (const commit of streamHistory(path, head, useMailmap)) {
    changedFiles += commit.files.length;
    for (const file of commit.files) {
      if (file.binary) continue;
      added += file.added;
      removed += file.removed;
    }
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  return {
    changedFiles,
    added: String(added),
    removed: String(removed),
    churn: String(added + removed),
    analysisSeconds: (performance.now() - started) / 1_000,
    peakRssMb: peakRss / 1024 / 1024,
  };
}

const sizes = (process.env.RAT_BENCHMARK_SIZES ?? '1000')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isSafeInteger(value) && value > 0);

if (sizes.length === 0)
  throw new Error('RAT_BENCHMARK_SIZES must contain at least one positive integer');

const results: BenchmarkResult[] = [];
for (const commits of sizes) {
  const generated = await generateRepository(commits);
  try {
    const analysis = await analyze(generated.path);
    results.push({ commits, generationSeconds: generated.generationSeconds, ...analysis });
  } finally {
    await rm(generated.path, { recursive: true, force: true });
  }
}

await mkdir(resolve('storage'), { recursive: true });
await writeFile(
  resolve('storage', 'benchmark-results.json'),
  `${JSON.stringify(results, null, 2)}\n`,
);
console.table(results);
console.log('Wrote storage/benchmark-results.json');
