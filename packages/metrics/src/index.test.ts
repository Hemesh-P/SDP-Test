import { describe, expect, it } from 'vitest';
import {
  aggregateCommitPaths,
  authorTotals,
  displayPath,
  parentDirectories,
  safeRatio,
  totals,
} from './index';

describe('metric formulas', () => {
  it('calculates commit-set metrics', () => {
    expect(
      totals(
        [
          { added: 10n, removed: 2n },
          { added: 0n, removed: 3n },
        ],
        4n,
      ),
    ).toEqual({
      added: 10n,
      removed: 5n,
      growth: 5n,
      churn: 15n,
      modifications: 2n,
      modificationFrequency: 0.5,
      churnRate: 3.75,
    });
  });

  it('returns zero rates for an empty commit set', () => {
    expect(totals([], 0n)).toMatchObject({ modificationFrequency: 0, churnRate: 0 });
    expect(safeRatio(5n, 0n)).toBe(0);
  });

  it('calculates author ownership from total churn', () => {
    expect(authorTotals([{ added: 2n, removed: 1n }], 12n)).toEqual({
      modifications: 1n,
      churn: 3n,
      ownership: 0.25,
    });
  });
});

describe('directory propagation', () => {
  it('returns root and all parent directories', () => {
    expect(parentDirectories(Buffer.from('src/lib/file.ts')).map((value) => value.toString())).toEqual([
      '',
      'src',
      'src/lib',
    ]);
  });

  it('deduplicates directory rows within one commit', () => {
    const result = aggregateCommitPaths([
      { path: Buffer.from('src/a.ts'), added: 2n, removed: 0n },
      { path: Buffer.from('src/b.ts'), added: 1n, removed: 3n },
    ]);
    expect(result.get(`directory:${Buffer.from('src').toString('base64')}`)).toMatchObject({
      added: 3n,
      removed: 3n,
    });
    expect(result.get('root:')).toMatchObject({ added: 3n, removed: 3n });
    expect(result).toHaveLength(4);
  });
});

describe('displayPath', () => {
  it('preserves valid UTF-8 and escapes invalid bytes', () => {
    expect(displayPath(Buffer.from('src/café.ts'))).toBe('src/café.ts');
    expect(displayPath(Buffer.from([0xff, 0x2f, 0x61]))).toBe('\\xff/a');
  });
});
