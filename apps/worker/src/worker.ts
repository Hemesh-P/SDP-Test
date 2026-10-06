import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import PgBoss, { type Job } from 'pg-boss';
import pino from 'pino';
import { createPool, migrate, type DatabasePool } from '@rat/db';
import {
  ANALYZER_VERSION,
  analyzeRepository,
  cloneMirror,
  defaultRef,
  discoverRepositories,
  extractRepositoryArchive,
  listRefs,
  mirrorLocalRepository,
  resolveRef,
  runGit,
  validateGitMarker,
  validateRepository,
} from '@rat/git-analysis';
import { loadWorkerConfig } from './config';

interface RepositoryJob {
  repositoryId: string;
  analysisId?: string;
}

interface DeleteJob extends RepositoryJob {
  storagePath: string;
  archivePath?: string | null;
}

interface RepositoryRecord {
  id: string;
  source_type: 'clone' | 'upload';
  source_url: string | null;
  source_archive_path: string | null;
  storage_path: string;
  requested_ref: string | null;
  default_ref: string | null;
}

const config = loadWorkerConfig();
const logger = pino({ level: config.LOG_LEVEL });
const pool = createPool(config.DATABASE_URL);
await migrate(pool);
const boss = new PgBoss({ connectionString: config.DATABASE_URL, application_name: 'rat-worker' });
await boss.start();

async function report(
  repositoryId: string,
  analysisId: string | null,
  state: string,
  progress: number,
  message: string,
): Promise<void> {
  await pool.query(
    `UPDATE repositories SET state = $2, progress = $3, progress_stage = $4, updated_at = now()
     WHERE id = $1`,
    [repositoryId, state, progress, message],
  );
  await pool.query(
    `INSERT INTO job_events (repository_id, analysis_id, stage, progress, message)
     VALUES ($1, $2, $3, $4, $5)`,
    [repositoryId, analysisId, state, progress, message],
  );
}

async function repositoryRecord(repositoryId: string): Promise<RepositoryRecord> {
  const result = await pool.query<RepositoryRecord>('SELECT * FROM repositories WHERE id = $1', [repositoryId]);
  const record = result.rows[0];
  if (!record) throw new Error('Repository no longer exists');
  return record;
}

async function persistRefs(record: RepositoryRecord): Promise<{ selectedRef: string; selectedOid: string }> {
  const refs = await listRefs(record.storage_path);
  const fallback = await defaultRef(record.storage_path);
  const selectedRef = record.requested_ref ?? fallback;
  const selectedOid = await resolveRef(record.storage_path, selectedRef);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM repository_refs WHERE repository_id = $1', [record.id]);
    for (const ref of refs) {
      await client.query(
        `INSERT INTO repository_refs (repository_id, name, kind, target_oid, is_default)
         VALUES ($1, $2, $3, $4, $5)`,
        [record.id, ref.name, ref.kind, ref.oid, ref.name === selectedRef],
      );
    }
    await client.query(
      'UPDATE repositories SET default_ref = $2, updated_at = now() WHERE id = $1',
      [record.id, selectedRef],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { selectedRef, selectedOid };
}

async function assertRootTotals(pool: DatabasePool, analysisId: string): Promise<void> {
  const result = await pool.query<{ root_churn: string; file_churn: string }>(
    `WITH selected AS (
       SELECT commit_id FROM analysis_commits WHERE analysis_id = $1
     )
     SELECT
       coalesce(sum(m.added + m.removed) FILTER (WHERE o.kind = 'root'), 0)::text AS root_churn,
       coalesce(sum(m.added + m.removed) FILTER (WHERE o.kind = 'file'), 0)::text AS file_churn
     FROM selected s
     JOIN commit_object_metrics m ON m.commit_id = s.commit_id
     JOIN objects o ON o.id = m.object_id`,
    [analysisId],
  );
  if (result.rows[0]?.root_churn !== result.rows[0]?.file_churn) {
    throw new Error('Analysis consistency check failed');
  }
}

async function executeAnalysis(
  record: RepositoryRecord,
  analysisId: string,
  referenceName: string,
  referenceOid?: string,
): Promise<void> {
  const oid = referenceOid ?? (await resolveRef(record.storage_path, referenceName));
  await report(record.id, analysisId, 'analyzing', 0.15, `Analyzing ${referenceName}`);
  let lastProgressAt = 0;
  const result = await analyzeRepository({
    pool,
    repositoryId: record.id,
    analysisId,
    repositoryPath: record.storage_path,
    referenceOid: oid,
    onProgress: async (processed, total) => {
      const now = Date.now();
      if (now - lastProgressAt < 2_000 && processed !== total) return;
      lastProgressAt = now;
      const fraction = total === 0 ? 1 : processed / total;
      await report(
        record.id,
        analysisId,
        'analyzing',
        Math.min(0.9, 0.15 + fraction * 0.7),
        `Analyzed ${processed.toLocaleString()} of ${total.toLocaleString()} commits`,
      );
      await pool.query('UPDATE analysis_runs SET processed_commits = $2 WHERE id = $1', [analysisId, processed]);
    },
  });
  await report(record.id, analysisId, 'rolling_up', 0.93, 'Validating aggregate metrics');
  await assertRootTotals(pool, analysisId);
  await pool.query(
    `UPDATE analysis_runs SET state = 'ready', processed_commits = $2, completed_at = now() WHERE id = $1`,
    [analysisId, result.commitCount],
  );
  await pool.query(
    `UPDATE repositories SET active_analysis_id = $2, state = 'ready', progress = 1,
       progress_stage = 'Analysis complete', commit_count = $3, last_error = NULL, updated_at = now()
     WHERE id = $1`,
    [record.id, analysisId, result.commitCount],
  );
  await report(record.id, analysisId, 'ready', 1, `Analysis complete: ${result.commitCount.toLocaleString()} commits`);
}

async function acquire(record: RepositoryRecord): Promise<void> {
  await rm(record.storage_path, { recursive: true, force: true });
  if (record.source_type === 'clone') {
    if (!record.source_url) throw new Error('Clone repository has no source URL');
    await cloneMirror(record.source_url, record.storage_path, config.GIT_TIMEOUT_MS);
    return;
  }
  if (!record.source_archive_path) throw new Error('Uploaded repository has no archive');
  const extractionRoot = join(config.UPLOAD_TMP_DIR, `${record.id}-extracted`);
  await rm(extractionRoot, { recursive: true, force: true });
  try {
    await extractRepositoryArchive(record.source_archive_path, extractionRoot, {
      maxEntries: config.MAX_ARCHIVE_ENTRIES,
      maxExtractedBytes: config.MAX_EXTRACTED_BYTES,
    });
    const candidates = await discoverRepositories(extractionRoot);
    if (candidates.length === 0) throw new Error('No Git repository was found in the ZIP archive');
    if (candidates.length > 1) throw new Error('The ZIP archive contains more than one Git repository');
    await validateGitMarker(candidates[0]!, extractionRoot);
    await mirrorLocalRepository(candidates[0]!, record.storage_path, config.GIT_TIMEOUT_MS);
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

async function ingest(repositoryId: string): Promise<void> {
  const record = await repositoryRecord(repositoryId);
  let analysisId: string | null = null;
  try {
    await report(repositoryId, null, 'acquiring', 0.03, 'Acquiring repository history');
    await acquire(record);
    await report(repositoryId, null, 'validating', 0.08, 'Validating Git objects');
    await validateRepository(record.storage_path);
    await report(repositoryId, null, 'enumerating', 0.11, 'Enumerating references');
    const { selectedRef, selectedOid } = await persistRefs(record);
    analysisId = randomUUID();
    await pool.query(
      `INSERT INTO analysis_runs
       (id, repository_id, reference_name, reference_oid, analyzer_version, state)
       VALUES ($1, $2, $3, $4, $5, 'queued')`,
      [analysisId, repositoryId, selectedRef, selectedOid, ANALYZER_VERSION],
    );
    await executeAnalysis(record, analysisId, selectedRef, selectedOid);
    if (record.source_archive_path) await rm(record.source_archive_path, { force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message.replaceAll(record.storage_path, '[repository]') : 'Unknown error';
    await pool.query(
      `UPDATE repositories SET state = 'failed', last_error = $2, progress_stage = 'Failed', updated_at = now()
       WHERE id = $1`,
      [repositoryId, message.slice(0, 2_000)],
    );
    if (analysisId) {
      await pool.query("UPDATE analysis_runs SET state = 'failed', error = $2, completed_at = now() WHERE id = $1", [
        analysisId,
        message.slice(0, 2_000),
      ]);
    }
    await report(repositoryId, analysisId, 'failed', 0, message.slice(0, 500));
    throw error;
  }
}

async function refresh(repositoryId: string): Promise<void> {
  const record = await repositoryRecord(repositoryId);
  try {
    await report(repositoryId, null, 'acquiring', 0.05, 'Refreshing repository references');
    if (record.source_type === 'clone') {
      await runGit(['-C', record.storage_path, 'remote', 'update', '--prune'], {
        timeoutMs: config.GIT_TIMEOUT_MS,
        maxOutputBytes: 4 * 1024 * 1024,
      });
    }
    const { selectedRef, selectedOid } = await persistRefs(record);
    const analysisId = randomUUID();
    await pool.query(
      `INSERT INTO analysis_runs
       (id, repository_id, reference_name, reference_oid, analyzer_version, state)
       VALUES ($1, $2, $3, $4, $5, 'queued')`,
      [analysisId, repositoryId, selectedRef, selectedOid, ANALYZER_VERSION],
    );
    await executeAnalysis(record, analysisId, selectedRef, selectedOid);
  } catch (error) {
    await pool.query("UPDATE repositories SET state = 'failed', last_error = $2 WHERE id = $1", [
      repositoryId,
      error instanceof Error ? error.message.slice(0, 2_000) : 'Unknown refresh failure',
    ]);
    throw error;
  }
}

async function analyzeExisting(repositoryId: string, analysisId: string): Promise<void> {
  const record = await repositoryRecord(repositoryId);
  const result = await pool.query<{ reference_name: string }>('SELECT reference_name FROM analysis_runs WHERE id = $1', [
    analysisId,
  ]);
  const referenceName = result.rows[0]?.reference_name;
  if (!referenceName) throw new Error('Analysis request not found');
  await executeAnalysis(record, analysisId, referenceName);
}

await boss.work<RepositoryJob>(
  'repository.ingest',
  { teamSize: config.ANALYSIS_CONCURRENCY, teamConcurrency: 1 },
  async (job: Job<RepositoryJob>) => ingest(job.data.repositoryId),
);
await boss.work<RepositoryJob>(
  'repository.refresh',
  { teamSize: config.ANALYSIS_CONCURRENCY, teamConcurrency: 1 },
  async (job: Job<RepositoryJob>) => refresh(job.data.repositoryId),
);
await boss.work<RepositoryJob>(
  'repository.analyze',
  { teamSize: config.ANALYSIS_CONCURRENCY, teamConcurrency: 1 },
  async (job: Job<RepositoryJob>) => {
    if (!job.data.analysisId) throw new Error('Analysis job has no analysis ID');
    await analyzeExisting(job.data.repositoryId, job.data.analysisId);
  },
);
await boss.work<DeleteJob>('repository.delete', async (job: Job<DeleteJob>) => {
  await rm(job.data.storagePath, { recursive: true, force: true });
  if (job.data.archivePath) await rm(job.data.archivePath, { force: true });
  await pool.query('DELETE FROM repositories WHERE id = $1', [job.data.repositoryId]);
});

logger.info({ concurrency: config.ANALYSIS_CONCURRENCY }, 'RAT worker started');

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'RAT worker stopping');
  await boss.stop({ graceful: true, timeout: 30_000 });
  await pool.end();
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
