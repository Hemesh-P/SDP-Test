import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  customType,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const repositories = pgTable('repositories', {
  id: uuid('id').primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  sourceType: varchar('source_type', { length: 16 }).notNull(),
  sourceUrl: text('source_url'),
  sourceArchivePath: text('source_archive_path'),
  storagePath: text('storage_path').notNull(),
  requestedRef: text('requested_ref'),
  defaultRef: text('default_ref'),
  activeAnalysisId: uuid('active_analysis_id'),
  state: varchar('state', { length: 24 }).notNull().default('queued'),
  progress: doublePrecision('progress').notNull().default(0),
  progressStage: text('progress_stage'),
  commitCount: bigint('commit_count', { mode: 'bigint' }).notNull().default(0n),
  lastError: text('last_error'),
  createdAt,
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const analysisRuns = pgTable(
  'analysis_runs',
  {
    id: uuid('id').primaryKey(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    referenceName: text('reference_name').notNull(),
    referenceOid: varchar('reference_oid', { length: 64 }),
    analyzerVersion: varchar('analyzer_version', { length: 40 }).notNull(),
    state: varchar('state', { length: 24 }).notNull().default('queued'),
    totalCommits: bigint('total_commits', { mode: 'bigint' }).notNull().default(0n),
    processedCommits: bigint('processed_commits', { mode: 'bigint' }).notNull().default(0n),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    error: text('error'),
    createdAt,
  },
  (table) => [index('analysis_runs_repository_created_idx').on(table.repositoryId, table.createdAt)],
);

export const authorIdentities = pgTable(
  'author_identities',
  {
    id: uuid('id').primaryKey(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    email: text('email').notNull(),
    createdAt,
  },
  (table) => [uniqueIndex('author_identity_natural_idx').on(table.repositoryId, table.name, table.email)],
);

export const commits = pgTable(
  'commits',
  {
    id: uuid('id').primaryKey(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    oid: varchar('oid', { length: 64 }).notNull(),
    parentOid: varchar('parent_oid', { length: 64 }),
    treeOid: varchar('tree_oid', { length: 64 }).notNull(),
    rawAuthorId: uuid('raw_author_id')
      .notNull()
      .references(() => authorIdentities.id),
    committerAt: timestamp('committer_at', { withTimezone: true }).notNull(),
    subject: text('subject').notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex('commits_repository_oid_idx').on(table.repositoryId, table.oid),
    index('commits_repository_time_idx').on(table.repositoryId, table.committerAt, table.id),
  ],
);

export const analysisCommits = pgTable(
  'analysis_commits',
  {
    analysisId: uuid('analysis_id')
      .notNull()
      .references(() => analysisRuns.id, { onDelete: 'cascade' }),
    commitId: uuid('commit_id')
      .notNull()
      .references(() => commits.id, { onDelete: 'cascade' }),
    sequence: bigint('sequence', { mode: 'bigint' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.analysisId, table.commitId] })],
);

export const objects = pgTable(
  'objects',
  {
    id: uuid('id').primaryKey(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 16 }).notNull(),
    pathBytes: bytea('path_bytes').notNull(),
    displayPath: text('display_path').notNull(),
    parentId: uuid('parent_id'),
    depth: integer('depth').notNull(),
    binaryObserved: boolean('binary_observed').notNull().default(false),
    createdAt,
  },
  (table) => [
    uniqueIndex('objects_natural_idx').on(table.repositoryId, table.kind, table.pathBytes),
    index('objects_parent_idx').on(table.repositoryId, table.parentId, table.displayPath),
  ],
);

export const commitObjectMetrics = pgTable(
  'commit_object_metrics',
  {
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    commitId: uuid('commit_id')
      .notNull()
      .references(() => commits.id, { onDelete: 'cascade' }),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    added: bigint('added', { mode: 'bigint' }).notNull(),
    removed: bigint('removed', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.commitId, table.objectId] }),
    index('metrics_object_commit_idx').on(table.objectId, table.commitId),
  ],
);

export const dailyObjectAuthorRollups = pgTable(
  'daily_object_author_rollups',
  {
    analysisId: uuid('analysis_id')
      .notNull()
      .references(() => analysisRuns.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    rawAuthorId: uuid('raw_author_id')
      .notNull()
      .references(() => authorIdentities.id, { onDelete: 'cascade' }),
    added: bigint('added', { mode: 'bigint' }).notNull(),
    removed: bigint('removed', { mode: 'bigint' }).notNull(),
    modifications: bigint('modifications', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.analysisId, table.day, table.objectId, table.rawAuthorId] }),
  ],
);
