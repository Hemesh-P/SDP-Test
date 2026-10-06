export interface LineDelta {
  added: bigint;
  removed: bigint;
}

export interface MetricTotals extends LineDelta {
  growth: bigint;
  churn: bigint;
  modifications: bigint;
  modificationFrequency: number;
  churnRate: number;
}

export interface AuthorMetricTotals {
  modifications: bigint;
  churn: bigint;
  ownership: number;
}

export interface PathMetric extends LineDelta {
  path: Buffer;
}

export interface AggregatedPathMetric extends PathMetric {
  kind: 'root' | 'directory' | 'file';
}

export function growth(delta: LineDelta): bigint {
  return delta.added - delta.removed;
}

export function churn(delta: LineDelta): bigint {
  return delta.added + delta.removed;
}

export function safeRatio(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return 0;
  return Number(numerator) / Number(denominator);
}

export function totals(
  deltas: Iterable<LineDelta>,
  commitCount: bigint,
): MetricTotals {
  let added = 0n;
  let removed = 0n;
  let modifications = 0n;

  for (const delta of deltas) {
    added += delta.added;
    removed += delta.removed;
    if (churn(delta) > 0n) modifications += 1n;
  }

  const changed = added + removed;
  return {
    added,
    removed,
    growth: added - removed,
    churn: changed,
    modifications,
    modificationFrequency: safeRatio(modifications, commitCount),
    churnRate: safeRatio(changed, commitCount),
  };
}

export function authorTotals(
  authorDeltas: Iterable<LineDelta>,
  totalChurn: bigint,
): AuthorMetricTotals {
  let modifications = 0n;
  let authorChurn = 0n;
  for (const delta of authorDeltas) {
    const changed = churn(delta);
    authorChurn += changed;
    if (changed > 0n) modifications += 1n;
  }
  return {
    modifications,
    churn: authorChurn,
    ownership: safeRatio(authorChurn, totalChurn),
  };
}

export function parentDirectories(path: Buffer): Buffer[] {
  const parents: Buffer[] = [Buffer.alloc(0)];
  for (let index = 0; index < path.length; index += 1) {
    if (path[index] === 0x2f && index > 0) parents.push(path.subarray(0, index));
  }
  return parents;
}

export function aggregateCommitPaths(
  fileMetrics: readonly PathMetric[],
): Map<string, AggregatedPathMetric> {
  const result = new Map<string, AggregatedPathMetric>();

  const add = (path: Buffer, kind: AggregatedPathMetric['kind'], delta: LineDelta): void => {
    const key = `${kind}:${path.toString('base64')}`;
    const current = result.get(key);
    if (current) {
      current.added += delta.added;
      current.removed += delta.removed;
    } else {
      result.set(key, { path: Buffer.from(path), kind, ...delta });
    }
  };

  for (const fileMetric of fileMetrics) {
    if (churn(fileMetric) === 0n) continue;
    add(fileMetric.path, 'file', fileMetric);
    for (const directory of parentDirectories(fileMetric.path)) {
      add(directory, directory.length === 0 ? 'root' : 'directory', fileMetric);
    }
  }

  return result;
}

export function displayPath(path: Buffer): string {
  const decoded = path.toString('utf8');
  if (Buffer.from(decoded, 'utf8').equals(path)) return decoded;
  let output = '';
  for (const byte of path) {
    if (byte >= 0x20 && byte <= 0x7e && byte !== 0x5c) output += String.fromCharCode(byte);
    else output += `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return output;
}
