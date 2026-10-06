import { createWriteStream } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z, ZodError } from 'zod';
import {
  CloneRepositorySchema,
  CreateAnalysisSchema,
  CreateCommitSetSchema,
  MergeAuthorsSchema,
  MetricsQuerySchema,
  PaginationSchema,
  UpdateCommitSetSchema,
} from '@rat/contracts';
import { validateRemoteUrl } from '@rat/git-analysis';
import { queryMetrics } from './metrics-service';
import type { ApiConfig } from './config';

export interface JobQueue {
  send(name: string, data: object, options?: object): Promise<string | null>;
}

export interface AppDependencies {
  pool: Pool;
  queue: JobQueue;
  config: ApiConfig;
}

interface RepositoryRow {
  id: string;
  name: string;
  source_type: 'clone' | 'upload';
  source_url: string | null;
  default_ref: string | null;
  state: string;
  progress: number;
  progress_stage: string | null;
  active_analysis_id: string | null;
  commit_count: string;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

function repositoryDto(row: RepositoryRow) {
  return {
    id: row.id,
    name: row.name,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    defaultRef: row.default_ref,
    state: row.state,
    progress: row.progress,
    progressStage: row.progress_stage,
    activeAnalysisId: row.active_analysis_id,
    commitCount: Number(row.commit_count),
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function parseUuid(value: unknown, label = 'id'): string {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw new Error(`INVALID_${label.toUpperCase()}`);
  return parsed.data;
}

export async function buildApp({ pool, queue, config }: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => randomUUID(),
  });

  await app.register(cors, { origin: config.WEB_ORIGIN, credentials: false });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
  await app.register(multipart, {
    limits: { files: 1, fields: 5, fileSize: config.MAX_UPLOAD_BYTES },
  });
  await app.register(swagger, {
    openapi: { info: { title: 'Repo Analysis Tool API', version: '1.0.0' } },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.addHook('preHandler', async (request, reply) => {
    if (!config.ADMIN_TOKEN || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    if (request.headers['x-admin-token'] !== config.ADMIN_TOKEN) {
      await reply
        .code(401)
        .send({ error: { code: 'UNAUTHORIZED', message: 'A valid admin token is required' } });
    }
  });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  app.get('/v1/repositories', async () => {
    const result = await pool.query<RepositoryRow>(
      'SELECT * FROM repositories ORDER BY created_at DESC',
    );
    return { items: result.rows.map(repositoryDto) };
  });

  app.get('/v1/repositories/:id', async (request, reply) => {
    const id = parseUuid((request.params as { id?: string }).id);
    const result = await pool.query<RepositoryRow>('SELECT * FROM repositories WHERE id = $1', [
      id,
    ]);
    if (!result.rowCount)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Repository not found' } });
    return repositoryDto(result.rows[0]!);
  });

  app.post('/v1/repositories/clone', async (request, reply) => {
    const input = CloneRepositorySchema.parse(request.body);
    const remote = await validateRemoteUrl(input.url);
    const id = randomUUID();
    const storagePath = join(config.REPO_STORAGE_DIR, `${id}.git`);
    await pool.query(
      `INSERT INTO repositories
       (id, name, source_type, source_url, storage_path, requested_ref, state, progress_stage)
       VALUES ($1, $2, 'clone', $3, $4, $5, 'queued', 'Waiting for worker')`,
      [id, input.name, remote.safeDisplayUrl, storagePath, input.ref ?? null],
    );
    await queue.send('repository.ingest', { repositoryId: id });
    const result = await pool.query<RepositoryRow>('SELECT * FROM repositories WHERE id = $1', [
      id,
    ]);
    return reply.code(202).send(repositoryDto(result.rows[0]!));
  });

  app.post('/v1/repositories/upload', async (request, reply) => {
    const part = await request.file();
    if (!part)
      return reply
        .code(400)
        .send({ error: { code: 'FILE_REQUIRED', message: 'A ZIP file is required' } });
    const nameField = part.fields.name;
    const firstNameField = Array.isArray(nameField) ? nameField[0] : nameField;
    const uploadedName =
      firstNameField && 'value' in firstNameField
        ? firstNameField.value
        : part.filename.replace(/\.zip$/i, '');
    const name = z.string().trim().min(1).max(120).parse(uploadedName);
    const id = randomUUID();
    await mkdir(config.UPLOAD_TMP_DIR, { recursive: true, mode: 0o700 });
    const archivePath = join(config.UPLOAD_TMP_DIR, `${id}.zip`);
    try {
      await pipeline(part.file, createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }));
      if (part.file.truncated) throw new Error('UPLOAD_TOO_LARGE');
      const handle = await open(archivePath, 'r');
      const signature = Buffer.alloc(4);
      try {
        await handle.read(signature, 0, 4, 0);
      } finally {
        await handle.close();
      }
      if (signature[0] !== 0x50 || signature[1] !== 0x4b) {
        throw new Error('INVALID_ZIP');
      }
      const storagePath = join(config.REPO_STORAGE_DIR, `${id}.git`);
      await pool.query(
        `INSERT INTO repositories
         (id, name, source_type, source_archive_path, storage_path, state, progress_stage)
         VALUES ($1, $2, 'upload', $3, $4, 'queued', 'Waiting for worker')`,
        [id, name, archivePath, storagePath],
      );
      await queue.send('repository.ingest', { repositoryId: id });
      const result = await pool.query<RepositoryRow>('SELECT * FROM repositories WHERE id = $1', [
        id,
      ]);
      return reply.code(202).send(repositoryDto(result.rows[0]!));
    } catch (error) {
      await rm(archivePath, { force: true });
      throw error;
    }
  });

  app.post('/v1/repositories/:id/refresh', async (request, reply) => {
    const id = parseUuid((request.params as { id?: string }).id);
    const result = await pool.query(
      'UPDATE repositories SET state = $2, progress = 0, updated_at = now() WHERE id = $1',
      [id, 'queued'],
    );
    if (!result.rowCount)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Repository not found' } });
    await queue.send('repository.refresh', { repositoryId: id });
    return reply.code(202).send({ repositoryId: id, state: 'queued' });
  });

  app.delete('/v1/repositories/:id', async (request, reply) => {
    const id = parseUuid((request.params as { id?: string }).id);
    const result = await pool.query<{ storage_path: string; source_archive_path: string | null }>(
      `UPDATE repositories SET state = 'deleting', updated_at = now()
       WHERE id = $1 AND state <> 'deleting'
       RETURNING storage_path, source_archive_path`,
      [id],
    );
    if (!result.rowCount)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Repository not found' } });
    await queue.send('repository.delete', {
      repositoryId: id,
      storagePath: result.rows[0]!.storage_path,
      archivePath: result.rows[0]!.source_archive_path,
    });
    return reply.code(202).send({ repositoryId: id, state: 'deleting' });
  });

  app.get('/v1/repositories/:id/refs', async (request) => {
    const id = parseUuid((request.params as { id?: string }).id);
    const result = await pool.query(
      `SELECT name, kind, target_oid AS "targetOid", is_default AS "isDefault"
       FROM repository_refs WHERE repository_id = $1 ORDER BY is_default DESC, name`,
      [id],
    );
    return { items: result.rows };
  });

  app.post('/v1/repositories/:id/analyses', async (request, reply) => {
    const repositoryId = parseUuid((request.params as { id?: string }).id);
    const input = CreateAnalysisSchema.parse(request.body);
    const analysisId = randomUUID();
    const created = await pool.query(
      `INSERT INTO analysis_runs (id, repository_id, reference_name, analyzer_version)
       SELECT $1, id, $3, '1.0.0' FROM repositories WHERE id = $2
       RETURNING id`,
      [analysisId, repositoryId, input.ref],
    );
    if (!created.rowCount) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Repository not found' } });
    }
    await queue.send('repository.analyze', { repositoryId, analysisId });
    return reply.code(202).send({ id: analysisId, repositoryId, state: 'queued' });
  });

  app.get('/v1/repositories/:id/objects', async (request) => {
    const repositoryId = parseUuid((request.params as { id?: string }).id);
    const query = PaginationSchema.extend({ parentId: z.string().uuid().optional() }).parse(
      request.query,
    );
    const values: unknown[] = [repositoryId, query.limit];
    const clauses = ['repository_id = $1'];
    if (query.parentId) {
      values.push(query.parentId);
      clauses.push(`parent_id = $${values.length}::uuid`);
    } else if (!query.search) clauses.push('parent_id IS NULL');
    if (query.search) {
      values.push(`%${query.search}%`);
      clauses.push(`display_path ILIKE $${values.length}`);
    }
    const result = await pool.query(
      `SELECT id, kind, display_path AS path, parent_id AS "parentId", depth, binary_observed AS "binaryObserved"
       FROM objects WHERE ${clauses.join(' AND ')}
       ORDER BY kind, display_path LIMIT $2`,
      values,
    );
    return { items: result.rows };
  });

  app.get('/v1/analyses/:id/authors', async (request) => {
    const analysisId = parseUuid((request.params as { id?: string }).id);
    const result = await pool.query(
      `SELECT ag.id, ag.name, ag.email, ag.is_manual AS "isManual", count(gm.resolved_identity_id)::int AS identities,
              array_agg(gm.resolved_identity_id)::text[] AS "identityIds"
       FROM author_groups ag
       JOIN author_group_members gm ON gm.group_id = ag.id
       WHERE ag.analysis_id = $1
       GROUP BY ag.id ORDER BY ag.name, ag.email`,
      [analysisId],
    );
    return { items: result.rows };
  });

  app.get('/v1/analyses/:id/commits', async (request) => {
    const analysisId = parseUuid((request.params as { id?: string }).id);
    const query = PaginationSchema.parse(request.query);
    const values: unknown[] = [analysisId, query.limit];
    const clauses = ['ac.analysis_id = $1'];
    if (query.cursor) {
      values.push(query.cursor);
      clauses.push(`ac.sequence > $${values.length}::bigint`);
    }
    if (query.search) {
      values.push(`%${query.search}%`);
      clauses.push(`(c.oid ILIKE $${values.length} OR c.subject ILIKE $${values.length})`);
    }
    const result = await pool.query(
      `SELECT c.id, c.oid, c.subject, c.committer_at AS "committerAt", ai.name AS "authorName",
              ai.email AS "authorEmail", ac.sequence::text
       FROM analysis_commits ac
       JOIN commits c ON c.id = ac.commit_id
       JOIN author_identities ai ON ai.id = c.raw_author_id
       WHERE ${clauses.join(' AND ')} ORDER BY ac.sequence LIMIT $2`,
      values,
    );
    return { items: result.rows, nextCursor: result.rows.at(-1)?.sequence ?? null };
  });

  app.get('/v1/analyses/:id/commit-sets', async (request) => {
    const analysisId = parseUuid((request.params as { id?: string }).id);
    const result = await pool.query(
      `SELECT ss.id, ss.name, ss.created_at AS "createdAt", count(sm.commit_id)::int AS "commitCount"
       FROM saved_commit_sets ss
       LEFT JOIN saved_commit_set_members sm ON sm.commit_set_id = ss.id
       WHERE ss.analysis_id = $1
       GROUP BY ss.id
       ORDER BY ss.created_at DESC`,
      [analysisId],
    );
    return { items: result.rows };
  });

  app.post('/v1/commit-sets', async (request, reply) => {
    const input = CreateCommitSetSchema.parse(request.body);
    const id = randomUUID();
    const uniqueCommitIds = [...new Set(input.commitIds)];
    await withTransaction(pool, async (client) => {
      const valid = await client.query(
        `SELECT count(*)::int AS count FROM analysis_commits
         WHERE analysis_id = $1 AND commit_id = ANY($2::uuid[])`,
        [input.analysisId, uniqueCommitIds],
      );
      if (valid.rows[0]?.count !== uniqueCommitIds.length) throw new Error('INVALID_COMMIT_SET');
      await client.query(
        'INSERT INTO saved_commit_sets (id, analysis_id, name) VALUES ($1, $2, $3)',
        [id, input.analysisId, input.name],
      );
      await client.query(
        `INSERT INTO saved_commit_set_members (commit_set_id, commit_id)
         SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
        [id, uniqueCommitIds],
      );
    });
    return reply
      .code(201)
      .send({ id, ...input, commitIds: uniqueCommitIds, commitCount: uniqueCommitIds.length });
  });

  app.patch('/v1/commit-sets/:id', async (request, reply) => {
    const id = parseUuid((request.params as { id?: string }).id);
    const input = UpdateCommitSetSchema.parse(request.body);
    let analysisId: string | undefined;
    await withTransaction(pool, async (client) => {
      const existing = await client.query<{ analysis_id: string }>(
        'SELECT analysis_id FROM saved_commit_sets WHERE id = $1',
        [id],
      );
      analysisId = existing.rows[0]?.analysis_id;
      if (!analysisId) throw new Error('COMMIT_SET_NOT_FOUND');
      if (input.name !== undefined) {
        await client.query('UPDATE saved_commit_sets SET name = $2 WHERE id = $1', [
          id,
          input.name,
        ]);
      }
      if (input.commitIds !== undefined) {
        const uniqueCommitIds = [...new Set(input.commitIds)];
        const valid = await client.query(
          `SELECT count(*)::int AS count FROM analysis_commits
           WHERE analysis_id = $1 AND commit_id = ANY($2::uuid[])`,
          [analysisId, uniqueCommitIds],
        );
        if (valid.rows[0]?.count !== uniqueCommitIds.length) throw new Error('INVALID_COMMIT_SET');
        await client.query('DELETE FROM saved_commit_set_members WHERE commit_set_id = $1', [id]);
        await client.query(
          `INSERT INTO saved_commit_set_members (commit_set_id, commit_id)
           SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
          [id, uniqueCommitIds],
        );
      }
    });
    return reply.send({ id, analysisId, updated: true });
  });

  app.delete('/v1/commit-sets/:id', async (request, reply) => {
    const id = parseUuid((request.params as { id?: string }).id);
    const result = await pool.query('DELETE FROM saved_commit_sets WHERE id = $1', [id]);
    if (!result.rowCount)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Commit set not found' } });
    return reply.code(204).send();
  });

  app.post('/v1/authors/merge', async (request, reply) => {
    const input = MergeAuthorsSchema.parse(request.body);
    const groupId = randomUUID();
    await withTransaction(pool, async (client) => {
      const valid = await client.query(
        `SELECT count(*)::int AS count FROM analysis_author_resolution
         WHERE analysis_id = $1 AND resolved_identity_id = ANY($2::uuid[])`,
        [input.analysisId, input.identityIds],
      );
      if (valid.rows[0]?.count !== new Set(input.identityIds).size)
        throw new Error('INVALID_AUTHOR_SELECTION');
      await client.query(
        `INSERT INTO author_groups (id, analysis_id, name, email, is_manual)
         VALUES ($1, $2, $3, $4, true)`,
        [groupId, input.analysisId, input.name, input.email ?? null],
      );
      await client.query(
        `UPDATE author_group_members SET group_id = $3
         WHERE analysis_id = $1 AND resolved_identity_id = ANY($2::uuid[])`,
        [input.analysisId, input.identityIds, groupId],
      );
      await client.query(
        `DELETE FROM author_groups ag WHERE analysis_id = $1 AND id <> $2
         AND NOT EXISTS (SELECT 1 FROM author_group_members gm WHERE gm.group_id = ag.id)`,
        [input.analysisId, groupId],
      );
    });
    return reply.code(201).send({ id: groupId, ...input, isManual: true });
  });

  app.post('/v1/authors/:groupId/unmerge', async (request) => {
    const groupId = parseUuid((request.params as { groupId?: string }).groupId, 'group_id');
    await withTransaction(pool, async (client) => {
      const group = await client.query<{ analysis_id: string }>(
        'SELECT analysis_id FROM author_groups WHERE id = $1 AND is_manual = true',
        [groupId],
      );
      if (!group.rowCount) throw new Error('AUTHOR_GROUP_NOT_FOUND');
      const analysisId = group.rows[0]!.analysis_id;
      const members = await client.query<{ id: string; name: string; email: string }>(
        `SELECT ai.id, ai.name, ai.email FROM author_group_members gm
         JOIN author_identities ai ON ai.id = gm.resolved_identity_id WHERE gm.group_id = $1`,
        [groupId],
      );
      for (const member of members.rows) {
        const replacement = randomUUID();
        await client.query(
          `INSERT INTO author_groups (id, analysis_id, name, email) VALUES ($1, $2, $3, $4)`,
          [replacement, analysisId, member.name, member.email],
        );
        await client.query(
          `UPDATE author_group_members SET group_id = $3
           WHERE analysis_id = $1 AND resolved_identity_id = $2`,
          [analysisId, member.id, replacement],
        );
      }
      await client.query('DELETE FROM author_groups WHERE id = $1', [groupId]);
    });
    return { id: groupId, unmerged: true };
  });

  app.post('/v1/metrics/query', async (request) =>
    queryMetrics(pool, MetricsQuerySchema.parse(request.body)),
  );

  app.post('/v1/metrics/compare', async (request) => {
    const queries = z.array(MetricsQuerySchema).min(2).max(4).parse(request.body);
    return { items: await Promise.all(queries.map((query) => queryMetrics(pool, query))) };
  });

  app.get('/v1/analyses/:id/events', async (request, reply) => {
    const analysisId = parseUuid((request.params as { id?: string }).id);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    let cursor = 0;
    let open = true;
    request.raw.once('close', () => {
      open = false;
    });
    while (open) {
      const result = await pool.query(
        `SELECT id, stage, progress, message, created_at AS "createdAt"
         FROM job_events WHERE analysis_id = $1 AND id > $2 ORDER BY id LIMIT 100`,
        [analysisId, cursor],
      );
      for (const event of result.rows) {
        cursor = Number(event.id);
        reply.raw.write(`id: ${event.id}\nevent: progress\ndata: ${JSON.stringify(event)}\n\n`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'request failed');
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request is invalid',
          requestId: request.id,
          details: error.flatten(),
        },
      });
    }
    const known: Record<string, [number, string]> = {
      INVALID_ZIP: [400, 'The uploaded file is not a ZIP archive'],
      UPLOAD_TOO_LARGE: [413, 'The uploaded file exceeds the configured limit'],
      INVALID_COMMIT_SET: [400, 'The commit set contains commits outside this analysis'],
      INVALID_AUTHOR_SELECTION: [400, 'The author selection is invalid'],
      AUTHOR_GROUP_NOT_FOUND: [404, 'Manual author group not found'],
      COMMIT_SET_NOT_FOUND: [404, 'Commit set not found'],
      OBJECT_NOT_FOUND: [404, 'Object not found for this analysis'],
    };
    const [status, message] = known[error.message] ?? [500, 'The request could not be completed'];
    return reply
      .code(status)
      .send({
        error: {
          code: error.message in known ? error.message : 'INTERNAL_ERROR',
          message,
          requestId: request.id,
        },
      });
  });

  return app;
}
