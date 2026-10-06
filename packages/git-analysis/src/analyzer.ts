import type { Pool, PoolClient } from 'pg';
import { v5 as uuidv5 } from 'uuid';
import { aggregateCommitPaths, displayPath, parentDirectories } from '@rat/metrics';
import { countNonMergeCommits, referenceHasMailmap, runGit } from './git';
import { streamHistory, type GitCommitRecord } from './history';

const UUID_NAMESPACE = uuidv5.URL;
const ANALYZER_VERSION = '1.0.0';

interface AuthorRow {
  id: string;
  repository_id: string;
  name: string;
  email: string;
}

interface ObjectRow {
  id: string;
  repository_id: string;
  kind: 'root' | 'directory' | 'file';
  path_base64: string;
  display_path: string;
  parent_id: string | null;
  depth: number;
  binary_observed: boolean;
}

interface CommitRow {
  id: string;
  repository_id: string;
  oid: string;
  parent_oid: string | null;
  tree_oid: string;
  raw_author_id: string;
  committer_at: string;
  subject: string;
}

interface MetricRow {
  repository_id: string;
  commit_id: string;
  object_id: string;
  added: string;
  removed: string;
}

interface Batch {
  authors: Map<string, AuthorRow>;
  objects: Map<string, ObjectRow>;
  commits: CommitRow[];
  analysisCommits: Array<{ analysis_id: string; commit_id: string; sequence: string }>;
  resolutions: Map<
    string,
    {
      analysis_id: string;
      raw_identity_id: string;
      resolved_identity_id: string;
      source: 'default' | 'mailmap';
    }
  >;
  groups: Map<string, { id: string; analysis_id: string; name: string; email: string }>;
  members: Map<string, { analysis_id: string; resolved_identity_id: string; group_id: string }>;
  metrics: MetricRow[];
}

export interface AnalyzeOptions {
  pool: Pool;
  repositoryId: string;
  analysisId: string;
  repositoryPath: string;
  referenceOid: string;
  signal?: AbortSignal;
  batchSize?: number;
  onProgress?: (processed: number, total: number) => Promise<void> | void;
}

function deterministicId(scope: string): string {
  return uuidv5(scope, UUID_NAMESPACE);
}

function authorId(repositoryId: string, name: string, email: string): string {
  return deterministicId(`rat:author:${repositoryId}:${name}\0${email}`);
}

function objectId(repositoryId: string, kind: ObjectRow['kind'], path: Buffer): string {
  return deterministicId(`rat:object:${repositoryId}:${kind}:${path.toString('base64')}`);
}

function commitId(repositoryId: string, oid: string): string {
  return deterministicId(`rat:commit:${repositoryId}:${oid}`);
}

function groupId(analysisId: string, resolvedIdentityId: string): string {
  return deterministicId(`rat:author-group:${analysisId}:${resolvedIdentityId}`);
}

function parentPath(path: Buffer): Buffer {
  const slash = path.lastIndexOf(0x2f);
  return slash < 0 ? Buffer.alloc(0) : path.subarray(0, slash);
}

function makeObjectRow(
  repositoryId: string,
  path: Buffer,
  kind: ObjectRow['kind'],
  binaryObserved = false,
): ObjectRow {
  const parent = kind === 'root' ? null : parentPath(path);
  const depth = path.length === 0 ? 0 : path.reduce((count, byte) => count + (byte === 0x2f ? 1 : 0), 1);
  return {
    id: objectId(repositoryId, kind, path),
    repository_id: repositoryId,
    kind,
    path_base64: path.toString('base64'),
    display_path: kind === 'root' ? '/' : displayPath(path),
    parent_id: parent === null ? null : objectId(repositoryId, parent.length === 0 ? 'root' : 'directory', parent),
    depth,
    binary_observed: binaryObserved,
  };
}

function emptyBatch(): Batch {
  return {
    authors: new Map(),
    objects: new Map(),
    commits: [],
    analysisCommits: [],
    resolutions: new Map(),
    groups: new Map(),
    members: new Map(),
    metrics: [],
  };
}

function addAuthor(batch: Batch, repositoryId: string, name: string, email: string): string {
  const id = authorId(repositoryId, name, email);
  batch.authors.set(id, { id, repository_id: repositoryId, name, email });
  return id;
}

function addObject(batch: Batch, row: ObjectRow): void {
  const current = batch.objects.get(row.id);
  if (current) current.binary_observed ||= row.binary_observed;
  else batch.objects.set(row.id, row);
}

function addCommitToBatch(
  batch: Batch,
  options: AnalyzeOptions,
  record: GitCommitRecord,
  sequence: number,
): void {
  const rawId = addAuthor(batch, options.repositoryId, record.rawAuthor.name, record.rawAuthor.email);
  const resolvedId = addAuthor(
    batch,
    options.repositoryId,
    record.mappedAuthor.name,
    record.mappedAuthor.email,
  );
  const id = commitId(options.repositoryId, record.oid);
  batch.commits.push({
    id,
    repository_id: options.repositoryId,
    oid: record.oid,
    parent_oid: record.parentOid,
    tree_oid: record.treeOid,
    raw_author_id: rawId,
    committer_at: new Date(record.committerTimestamp * 1_000).toISOString(),
    subject: record.subject,
  });
  batch.analysisCommits.push({
    analysis_id: options.analysisId,
    commit_id: id,
    sequence: String(sequence),
  });

  const resolutionKey = `${options.analysisId}:${rawId}`;
  batch.resolutions.set(resolutionKey, {
    analysis_id: options.analysisId,
    raw_identity_id: rawId,
    resolved_identity_id: resolvedId,
    source: rawId === resolvedId ? 'default' : 'mailmap',
  });
  const canonicalGroupId = groupId(options.analysisId, resolvedId);
  batch.groups.set(canonicalGroupId, {
    id: canonicalGroupId,
    analysis_id: options.analysisId,
    name: record.mappedAuthor.name,
    email: record.mappedAuthor.email,
  });
  batch.members.set(resolvedId, {
    analysis_id: options.analysisId,
    resolved_identity_id: resolvedId,
    group_id: canonicalGroupId,
  });

  for (const file of record.files) {
    addObject(batch, makeObjectRow(options.repositoryId, file.path, 'file', file.binary));
    for (const directory of parentDirectories(file.path)) {
      addObject(
        batch,
        makeObjectRow(options.repositoryId, directory, directory.length === 0 ? 'root' : 'directory'),
      );
    }
  }

  const textFiles = record.files
    .filter((file) => !file.binary)
    .map((file) => ({ path: file.path, added: file.added, removed: file.removed }));
  for (const aggregate of aggregateCommitPaths(textFiles).values()) {
    const object = makeObjectRow(options.repositoryId, aggregate.path, aggregate.kind);
    addObject(batch, object);
    batch.metrics.push({
      repository_id: options.repositoryId,
      commit_id: id,
      object_id: object.id,
      added: String(aggregate.added),
      removed: String(aggregate.removed),
    });
  }
}

async function insertJson(
  client: PoolClient,
  sql: string,
  rows: readonly unknown[],
): Promise<void> {
  if (rows.length > 0) await client.query(sql, [JSON.stringify(rows)]);
}

function dedupeMetrics(rows: readonly MetricRow[]): MetricRow[] {
  const byKey = new Map<string, MetricRow>();
  for (const row of rows) byKey.set(`${row.commit_id}:${row.object_id}`, row);
  return [...byKey.values()];
}

async function flushBatch(pool: Pool, batch: Batch): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertJson(
      client,
      `INSERT INTO author_identities (id, repository_id, name, email)
       SELECT id, repository_id, name, email
       FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, repository_id uuid, name text, email text)
       ON CONFLICT (id) DO NOTHING`,
      [...batch.authors.values()],
    );
    await insertJson(
      client,
      `INSERT INTO commits (id, repository_id, oid, parent_oid, tree_oid, raw_author_id, committer_at, subject)
       SELECT id, repository_id, oid, parent_oid, tree_oid, raw_author_id, committer_at, subject
       FROM jsonb_to_recordset($1::jsonb) AS x(
         id uuid, repository_id uuid, oid varchar(64), parent_oid varchar(64), tree_oid varchar(64),
         raw_author_id uuid, committer_at timestamptz, subject text)
       ON CONFLICT (id) DO NOTHING`,
      batch.commits,
    );
    await insertJson(
      client,
      `INSERT INTO analysis_commits (analysis_id, commit_id, sequence)
       SELECT analysis_id, commit_id, sequence
       FROM jsonb_to_recordset($1::jsonb) AS x(analysis_id uuid, commit_id uuid, sequence bigint)
       ON CONFLICT (analysis_id, commit_id) DO NOTHING`,
      batch.analysisCommits,
    );
    await insertJson(
      client,
      `INSERT INTO analysis_author_resolution
         (analysis_id, raw_identity_id, resolved_identity_id, source)
       SELECT analysis_id, raw_identity_id, resolved_identity_id, source
       FROM jsonb_to_recordset($1::jsonb) AS x(
         analysis_id uuid, raw_identity_id uuid, resolved_identity_id uuid, source varchar(16))
       ON CONFLICT (analysis_id, raw_identity_id) DO UPDATE SET
         resolved_identity_id = EXCLUDED.resolved_identity_id, source = EXCLUDED.source`,
      [...batch.resolutions.values()],
    );
    await insertJson(
      client,
      `INSERT INTO author_groups (id, analysis_id, name, email)
       SELECT id, analysis_id, name, email
       FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, analysis_id uuid, name text, email text)
       ON CONFLICT (id) DO NOTHING`,
      [...batch.groups.values()],
    );
    await insertJson(
      client,
      `INSERT INTO author_group_members (analysis_id, resolved_identity_id, group_id)
       SELECT analysis_id, resolved_identity_id, group_id
       FROM jsonb_to_recordset($1::jsonb) AS x(
         analysis_id uuid, resolved_identity_id uuid, group_id uuid)
       ON CONFLICT (analysis_id, resolved_identity_id) DO NOTHING`,
      [...batch.members.values()],
    );
    await insertJson(
      client,
      `INSERT INTO objects
         (id, repository_id, kind, path_bytes, display_path, parent_id, depth, binary_observed)
       SELECT id, repository_id, kind, decode(path_base64, 'base64'), display_path, parent_id, depth,
              binary_observed
       FROM jsonb_to_recordset($1::jsonb) AS x(
         id uuid, repository_id uuid, kind varchar(16), path_base64 text, display_path text,
         parent_id uuid, depth integer, binary_observed boolean)
       ON CONFLICT (id) DO UPDATE SET
         binary_observed = objects.binary_observed OR EXCLUDED.binary_observed`,
      [...batch.objects.values()],
    );
    await insertJson(
      client,
      `INSERT INTO commit_object_metrics
         (repository_id, commit_id, object_id, added, removed)
       SELECT repository_id, commit_id, object_id, added, removed
       FROM jsonb_to_recordset($1::jsonb) AS x(
         repository_id uuid, commit_id uuid, object_id uuid, added bigint, removed bigint)
       WHERE added + removed > 0
       ON CONFLICT (commit_id, object_id) DO UPDATE SET
         added = EXCLUDED.added, removed = EXCLUDED.removed`,
      dedupeMetrics(batch.metrics),
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function catalogReferenceTree(options: AnalyzeOptions): Promise<void> {
  const output = await runGit(
    ['-C', options.repositoryPath, 'ls-tree', '-r', '-z', '--name-only', options.referenceOid],
    { maxOutputBytes: 256 * 1024 * 1024, timeoutMs: 10 * 60_000 },
  );
  const batch = emptyBatch();
  for (const path of output.subarray(0, output.length - (output.at(-1) === 0 ? 1 : 0)).toString('binary').split('\0')) {
    if (!path) continue;
    const bytes = Buffer.from(path, 'binary');
    addObject(batch, makeObjectRow(options.repositoryId, bytes, 'file'));
    for (const directory of parentDirectories(bytes)) {
      addObject(batch, makeObjectRow(options.repositoryId, directory, directory.length === 0 ? 'root' : 'directory'));
    }
  }
  await flushBatch(options.pool, batch);
}

async function rebuildRollups(pool: Pool, analysisId: string): Promise<void> {
  await pool.query('DELETE FROM daily_object_author_rollups WHERE analysis_id = $1', [analysisId]);
  await pool.query(
    `INSERT INTO daily_object_author_rollups
       (analysis_id, day, object_id, raw_author_id, added, removed, modifications)
     SELECT ac.analysis_id, (c.committer_at AT TIME ZONE 'UTC')::date, m.object_id, c.raw_author_id,
            sum(m.added), sum(m.removed), count(*)
     FROM analysis_commits ac
     JOIN commits c ON c.id = ac.commit_id
     JOIN commit_object_metrics m ON m.commit_id = c.id
     WHERE ac.analysis_id = $1
     GROUP BY ac.analysis_id, (c.committer_at AT TIME ZONE 'UTC')::date, m.object_id, c.raw_author_id`,
    [analysisId],
  );
}

export async function analyzeRepository(options: AnalyzeOptions): Promise<{ commitCount: number }> {
  const total = await countNonMergeCommits(options.repositoryPath, options.referenceOid);
  const useMailmap = await referenceHasMailmap(options.repositoryPath, options.referenceOid);
  await options.pool.query(
    `UPDATE analysis_runs SET reference_oid = $2, state = 'analyzing', total_commits = $3,
       processed_commits = 0, started_at = now(), error = NULL
     WHERE id = $1`,
    [options.analysisId, options.referenceOid, total],
  );

  let batch = emptyBatch();
  let processed = 0;
  const batchSize = options.batchSize ?? 5_000;
  for await (const commit of streamHistory(options.repositoryPath, options.referenceOid, useMailmap)) {
    if (options.signal?.aborted) throw new Error('Analysis cancelled');
    addCommitToBatch(batch, options, commit, processed);
    processed += 1;
    if (batch.metrics.length >= batchSize || batch.commits.length >= 500) {
      await flushBatch(options.pool, batch);
      batch = emptyBatch();
      await options.onProgress?.(processed, total);
    }
  }
  await flushBatch(options.pool, batch);
  await catalogReferenceTree(options);
  await options.pool.query("UPDATE analysis_runs SET state = 'rolling_up' WHERE id = $1", [options.analysisId]);
  await rebuildRollups(options.pool, options.analysisId);
  await options.onProgress?.(processed, total);
  return { commitCount: processed };
}

export { ANALYZER_VERSION };
