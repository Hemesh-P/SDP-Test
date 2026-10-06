import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { referenceHasMailmap, resolveRef, streamHistory } from '@rat/git-analysis';

// Temporary diagnostic: locate per-file differences between our streaming
// parser and the lecturer's golden CSV for the git fixture.

const mirror = resolve('storage/golden', 'git.git');
const sha = '5a7d1e8045ce66c908f62598e26cbb8df7b39a90';
const csvPath = resolve('git_5a7d1e8045ce.csv');

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (const character of line) {
    if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) {
      fields.push(current);
      current = '';
    } else current += character;
  }
  fields.push(current);
  return fields;
}

const expected = new Map<string, { added: bigint; removed: bigint }>();
const csv = await readFile(csvPath, 'utf8');
const lines = csv.split(/\r?\n/);
const header = parseCsvLine(lines[0]!);
const col = (name: string) => header.indexOf(name);
for (let i = 1; i < lines.length; i += 1) {
  const line = lines[i];
  if (!line) continue;
  const row = parseCsvLine(line);
  if (row[col('object_type')] !== 'file' || row[col('author')] !== 'ALL') continue;
  expected.set(row[col('path')]!, {
    added: BigInt(row[col('added')]!),
    removed: BigInt(row[col('removed')]!),
  });
}

const actual = new Map<string, { added: bigint; removed: bigint }>();
const oid = await resolveRef(mirror, sha);
const useMailmap = await referenceHasMailmap(mirror, oid);
let commits = 0n;
for await (const commit of streamHistory(mirror, oid, useMailmap)) {
  commits += 1n;
  for (const file of commit.files) {
    if (file.binary) continue;
    const key = file.path.toString('utf8');
    const current = actual.get(key) ?? { added: 0n, removed: 0n };
    current.added += file.added;
    current.removed += file.removed;
    actual.set(key, current);
  }
  if (commits % 10_000n === 0n) process.stdout.write(`\r${commits.toLocaleString()} commits`);
}
process.stdout.write('\n');

const allPaths = new Set([...expected.keys(), ...actual.keys()]);
let mismatches = 0;
let expTotalAdded = 0n;
let expTotalRemoved = 0n;
let actTotalAdded = 0n;
let actTotalRemoved = 0n;
for (const value of expected.values()) {
  expTotalAdded += value.added;
  expTotalRemoved += value.removed;
}
for (const value of actual.values()) {
  actTotalAdded += value.added;
  actTotalRemoved += value.removed;
}
for (const path of allPaths) {
  const e = expected.get(path) ?? { added: 0n, removed: 0n };
  const a = actual.get(path) ?? { added: 0n, removed: 0n };
  if (e.added !== a.added || e.removed !== a.removed) {
    mismatches += 1;
    console.log(
      `MISMATCH ${JSON.stringify(path)} expected(+${e.added}/-${e.removed}) actual(+${a.added}/-${a.removed})`,
    );
  }
}
console.log('---');
console.log(`file rows in CSV (ALL): ${expected.size}, distinct files parsed: ${actual.size}`);
console.log(`expected file totals: +${expTotalAdded}/-${expTotalRemoved}`);
console.log(`actual   file totals: +${actTotalAdded}/-${actTotalRemoved}`);
console.log(`mismatching file paths: ${mismatches}`);
