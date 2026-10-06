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

const requested = process.argv.slice(2);
const selectedFixtures = requested.length === 0 ? Object.keys(fixtures) : requested;

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) {
      fields.push(current);
      current = '';
    } else current += character;
  }
  fields.push(current);
  return fields;
}

async function verifyGolden(name: keyof typeof fixtures): Promise<void> {
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
    if (commits % 1_000n === 0n)
      process.stdout.write(`\r${name}: ${commits.toLocaleString()} commits`);
  }
  process.stdout.write('\n');

  const csv = await readFile(resolve(fixture.csv), 'utf8');
  const [headerLine, summaryLine] = csv.split(/\r?\n/);
  if (!headerLine || !summaryLine) throw new Error(`${fixture.csv} has no repository summary row`);
  const header = parseCsvLine(headerLine);
  const summary = parseCsvLine(summaryLine);
  const value = (column: string): string => summary[header.indexOf(column)] ?? '';
  const actual = {
    commits: String(commits),
    added: String(added),
    removed: String(removed),
    growth: String(added - removed),
    churn: String(added + removed),
    modifications: String(modifications),
  };
  const expected = {
    commits: value('commit_count'),
    added: value('added'),
    removed: value('removed'),
    growth: value('growth'),
    churn: value('churn'),
    modifications: value('modifications'),
  };
  console.table({ expected, actual });
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (expected[key] !== actual[key])
      throw new Error(`${name} ${key}: expected ${expected[key]}, received ${actual[key]}`);
  }
  console.log(`${name} root metrics match ${fixture.csv}.`);
}

for (const requestedName of selectedFixtures) {
  if (!(requestedName in fixtures))
    throw new Error(`Choose one or more of: ${Object.keys(fixtures).join(', ')}`);
  await verifyGolden(requestedName as keyof typeof fixtures);
}
