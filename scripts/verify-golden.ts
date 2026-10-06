import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cloneMirror, resolveRef, streamHistory, referenceHasMailmap } from '@rat/git-analysis';

const fixtures = {
  cJSON: {
    url: 'https://github.com/DaveGamble/cJSON.git',
    sha: '6d9f2443ab071f86e5d9b43025a40929ec41c46c',
    csv: 'cJSON_6d9f2443ab07.csv',
  },
  redis: {
    url: 'https://github.com/redis/redis.git',
    sha: 'b540ca49cba815f3fbe634363c3df68d4f4f127a',
    csv: 'redis_b540ca49cba8.csv',
  },
  git: {
    url: 'https://github.com/git/git.git',
    sha: '5a7d1e8045ce66c908f62598e26cbb8df7b39a90',
    csv: 'git_5a7d1e8045ce.csv',
  },
} as const;

const requested = process.argv[2] ?? 'cJSON';
if (!(requested in fixtures)) throw new Error(`Choose one of: ${Object.keys(fixtures).join(', ')}`);
const name = requested as keyof typeof fixtures;
const fixture = fixtures[name];
const mirror = resolve('storage/golden', `${name}.git`);
try {
  await access(mirror);
} catch {
  console.log(`Cloning ${name} fixture…`);
  await cloneMirror(fixture.url, mirror, 60 * 60_000);
}
const oid = await resolveRef(mirror, fixture.sha);
const useMailmap = await referenceHasMailmap(mirror, oid);
let commits = 0n;
let modifications = 0n;
let added = 0n;
let removed = 0n;
for await (const commit of streamHistory(mirror, oid, useMailmap)) {
  commits += 1n;
  let commitChurn = 0n;
  for (const file of commit.files) {
    if (file.binary) continue;
    added += file.added;
    removed += file.removed;
    commitChurn += file.added + file.removed;
  }
  if (commitChurn > 0n) modifications += 1n;
  if (commits % 1_000n === 0n) process.stdout.write(`\r${commits.toLocaleString()} commits`);
}
process.stdout.write('\n');

const csv = await readFile(resolve(fixture.csv), 'utf8');
const expected = csv.split(/\r?\n/)[1]?.split(',');
if (!expected) throw new Error('Golden CSV has no repository summary row');
const actual = {
  commits: String(commits),
  added: String(added),
  removed: String(removed),
  growth: String(added - removed),
  churn: String(added + removed),
  modifications: String(modifications),
};
const wanted = {
  commits: expected[3],
  added: expected[7],
  removed: expected[8],
  growth: expected[9],
  churn: expected[10],
  modifications: expected[11],
};
console.table({ expected: wanted, actual });
for (const key of Object.keys(wanted) as Array<keyof typeof wanted>) {
  if (wanted[key] !== actual[key]) throw new Error(`${name} ${key}: expected ${wanted[key]}, received ${actual[key]}`);
}
console.log(`${name} root metrics match ${fixture.csv}.`);
