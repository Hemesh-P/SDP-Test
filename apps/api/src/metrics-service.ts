import type { MetricsQuery, MetricsResponse } from '@rat/contracts';
import type { Pool } from 'pg';

interface SelectedCte {
  sql: string;
  values: unknown[];
}

function selectedCommits(query: MetricsQuery): SelectedCte {
  const values: unknown[] = [query.analysisId];
  const clauses = ['ac.analysis_id = $1'];
  if (query.commits.mode === 'date') {
    if (query.commits.start) {
      values.push(query.commits.start);
      clauses.push(`c.committer_at >= $${values.length}::timestamptz`);
    }
    if (query.commits.end) {
      values.push(query.commits.end);
      clauses.push(`c.committer_at < $${values.length}::timestamptz`);
    }
  } else if (query.commits.mode === 'manual') {
    values.push(query.commits.commitSetId);
    clauses.push(`EXISTS (
      SELECT 1 FROM saved_commit_set_members sm
      JOIN saved_commit_sets ss ON ss.id = sm.commit_set_id
      WHERE sm.commit_id = c.id AND ss.id = $${values.length}::uuid AND ss.analysis_id = ac.analysis_id
    )`);
  }
  return {
    sql: `selected AS (
      SELECT c.id, c.raw_author_id, c.committer_at
      FROM analysis_commits ac
      JOIN commits c ON c.id = ac.commit_id
      WHERE ${clauses.join(' AND ')}
    )`,
    values,
  };
}

async function resolveObjectId(pool: Pool, analysisId: string, requested?: string): Promise<string> {
  if (requested) {
    const valid = await pool.query(
      `SELECT o.id FROM objects o
       JOIN analysis_runs a ON a.repository_id = o.repository_id
       WHERE a.id = $1 AND o.id = $2`,
      [analysisId, requested],
    );
    if (!valid.rowCount) throw new Error('OBJECT_NOT_FOUND');
    return requested;
  }
  const root = await pool.query<{ id: string }>(
    `SELECT o.id FROM objects o
     JOIN analysis_runs a ON a.repository_id = o.repository_id
     WHERE a.id = $1 AND o.kind = 'root' AND octet_length(o.path_bytes) = 0
     LIMIT 1`,
    [analysisId],
  );
  const id = root.rows[0]?.id;
  if (!id) throw new Error('OBJECT_NOT_FOUND');
  return id;
}

interface TotalRow {
  commit_count: string;
  added: string;
  removed: string;
  modifications: string;
}

interface AuthorRow {
  churn: string;
  modifications: string;
}

interface SeriesRow {
  key: string;
  label: string;
  added: string;
  removed: string;
  modifications: string;
}

function mappedSeries(rows: SeriesRow[]) {
  return rows.map((row) => {
    const added = BigInt(row.added);
    const removed = BigInt(row.removed);
    return {
      key: row.key,
      label: row.label,
      added: row.added,
      removed: row.removed,
      growth: String(added - removed),
      churn: String(added + removed),
      modifications: row.modifications,
    };
  });
}

async function querySeries(
  pool: Pool,
  query: MetricsQuery,
  objectId: string,
  cte: SelectedCte,
): Promise<ReturnType<typeof mappedSeries>> {
  if (query.groupBy === 'none') return [];
  const values = [...cte.values, objectId];
  const objectParameter = `$${values.length}::uuid`;
  let sql: string;

  if (query.groupBy === 'day' || query.groupBy === 'week' || query.groupBy === 'month') {
    values.push(query.groupBy);
    sql = `WITH ${cte.sql}
      SELECT date_trunc($${values.length}, s.committer_at AT TIME ZONE 'UTC')::text AS key,
             date_trunc($${values.length}, s.committer_at AT TIME ZONE 'UTC')::date::text AS label,
             coalesce(sum(m.added), 0)::text AS added,
             coalesce(sum(m.removed), 0)::text AS removed,
             count(m.commit_id)::text AS modifications
      FROM selected s
      JOIN commit_object_metrics m ON m.commit_id = s.id AND m.object_id = ${objectParameter}
      GROUP BY 1, 2 ORDER BY 1 LIMIT ${query.limit}`;
  } else if (query.groupBy === 'object') {
    sql = `WITH ${cte.sql}
      SELECT o.id::text AS key, o.display_path AS label,
             coalesce(sum(m.added), 0)::text AS added,
             coalesce(sum(m.removed), 0)::text AS removed,
             count(m.commit_id)::text AS modifications
      FROM objects o
      JOIN commit_object_metrics m ON m.object_id = o.id
      JOIN selected s ON s.id = m.commit_id
      WHERE o.parent_id = ${objectParameter}
      GROUP BY o.id, o.display_path
      ORDER BY sum(m.added + m.removed) DESC, o.display_path
      LIMIT ${query.limit}`;
  } else {
    sql = `WITH ${cte.sql}
      SELECT ag.id::text AS key, ag.name AS label,
             coalesce(sum(m.added), 0)::text AS added,
             coalesce(sum(m.removed), 0)::text AS removed,
             count(m.commit_id)::text AS modifications
      FROM selected s
      JOIN commit_object_metrics m ON m.commit_id = s.id AND m.object_id = ${objectParameter}
      JOIN analysis_author_resolution ar
        ON ar.analysis_id = $1 AND ar.raw_identity_id = s.raw_author_id
      JOIN author_group_members gm
        ON gm.analysis_id = $1 AND gm.resolved_identity_id = ar.resolved_identity_id
      JOIN author_groups ag ON ag.id = gm.group_id
      GROUP BY ag.id, ag.name
      ORDER BY sum(m.added + m.removed) DESC, ag.name
      LIMIT ${query.limit}`;
  }
  const result = await pool.query<SeriesRow>(sql, values);
  return mappedSeries(result.rows);
}

export async function queryMetrics(pool: Pool, query: MetricsQuery): Promise<MetricsResponse> {
  const objectId = await resolveObjectId(pool, query.analysisId, query.objectId);
  const cte = selectedCommits(query);
  const values = [...cte.values, objectId];
  const objectParameter = `$${values.length}::uuid`;
  const result = await pool.query<TotalRow>(
    `WITH ${cte.sql},
      commit_total AS (SELECT count(*)::bigint AS value FROM selected),
      metric_total AS (
        SELECT coalesce(sum(m.added), 0)::bigint AS added,
               coalesce(sum(m.removed), 0)::bigint AS removed,
               count(m.commit_id)::bigint AS modifications
        FROM selected s
        LEFT JOIN commit_object_metrics m
          ON m.commit_id = s.id AND m.object_id = ${objectParameter}
      )
     SELECT commit_total.value::text AS commit_count,
            metric_total.added::text AS added,
            metric_total.removed::text AS removed,
            metric_total.modifications::text AS modifications
     FROM commit_total CROSS JOIN metric_total`,
    values,
  );
  const total = result.rows[0] ?? { commit_count: '0', added: '0', removed: '0', modifications: '0' };
  const added = BigInt(total.added);
  const removed = BigInt(total.removed);
  const commitCount = BigInt(total.commit_count);
  const modifications = BigInt(total.modifications);
  const totalChurn = added + removed;

  let author: MetricsResponse['summary']['author'] = null;
  if (query.authorGroupId) {
    const authorValues = [...values, query.authorGroupId];
    const authorResult = await pool.query<AuthorRow>(
      `WITH ${cte.sql}
       SELECT coalesce(sum(m.added + m.removed), 0)::text AS churn,
              count(m.commit_id)::text AS modifications
       FROM selected s
       JOIN analysis_author_resolution ar
         ON ar.analysis_id = $1 AND ar.raw_identity_id = s.raw_author_id
       JOIN author_group_members gm
         ON gm.analysis_id = $1 AND gm.resolved_identity_id = ar.resolved_identity_id
         AND gm.group_id = $${authorValues.length}::uuid
       LEFT JOIN commit_object_metrics m
         ON m.commit_id = s.id AND m.object_id = ${objectParameter}`,
      authorValues,
    );
    const row = authorResult.rows[0] ?? { churn: '0', modifications: '0' };
    const authorChurn = BigInt(row.churn);
    author = {
      churn: row.churn,
      modifications: row.modifications,
      ownership: totalChurn === 0n ? 0 : Number(authorChurn) / Number(totalChurn),
    };
  }

  return {
    summary: {
      commitCount: total.commit_count,
      added: total.added,
      removed: total.removed,
      growth: String(added - removed),
      churn: String(totalChurn),
      modifications: total.modifications,
      modificationFrequency: commitCount === 0n ? 0 : Number(modifications) / Number(commitCount),
      churnRate: commitCount === 0n ? 0 : Number(totalChurn) / Number(commitCount),
      author,
    },
    series: await querySeries(pool, query, objectId, cte),
  };
}
