import { z } from 'zod';

export const RepositoryStateSchema = z.enum([
  'queued',
  'validating',
  'acquiring',
  'enumerating',
  'analyzing',
  'rolling_up',
  'ready',
  'failed',
  'cancelled',
  'deleting',
]);

export const SourceTypeSchema = z.enum(['clone', 'upload']);
export const ObjectKindSchema = z.enum(['root', 'directory', 'file']);

export const CloneRepositorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().url().max(2048),
  ref: z.string().trim().min(1).max(512).optional(),
});

export const CreateAnalysisSchema = z.object({
  ref: z.string().trim().min(1).max(512),
});

export const RepositorySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  sourceType: SourceTypeSchema,
  sourceUrl: z.string().nullable(),
  defaultRef: z.string().nullable(),
  state: RepositoryStateSchema,
  progress: z.number().min(0).max(1),
  progressStage: z.string().nullable(),
  activeAnalysisId: z.string().uuid().nullable(),
  commitCount: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const CommitFilterSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }),
  z.object({
    mode: z.literal('date'),
    start: z.string().datetime().optional(),
    end: z.string().datetime().optional(),
  }),
  z.object({ mode: z.literal('manual'), commitSetId: z.string().uuid() }),
]);

export const MetricsQuerySchema = z.object({
  analysisId: z.string().uuid(),
  objectId: z.string().uuid().optional(),
  authorGroupId: z.string().uuid().optional(),
  commits: CommitFilterSchema.default({ mode: 'all' }),
  groupBy: z.enum(['none', 'day', 'week', 'month', 'object', 'author']).default('none'),
  limit: z.number().int().min(1).max(500).default(50),
});

const CountStringSchema = z.string().regex(/^\d+$/);
const SignedCountStringSchema = z.string().regex(/^-?\d+$/);

export const MetricSummarySchema = z.object({
  commitCount: CountStringSchema,
  added: CountStringSchema,
  removed: CountStringSchema,
  growth: SignedCountStringSchema,
  churn: CountStringSchema,
  modifications: CountStringSchema,
  modificationFrequency: z.number().finite().nonnegative(),
  churnRate: z.number().finite().nonnegative(),
  author: z
    .object({
      modifications: CountStringSchema,
      churn: CountStringSchema,
      ownership: z.number().finite().min(0).max(1),
    })
    .nullable(),
});

export const MetricsResponseSchema = z.object({
  summary: MetricSummarySchema,
  series: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      added: CountStringSchema,
      removed: CountStringSchema,
      growth: SignedCountStringSchema,
      churn: CountStringSchema,
      modifications: CountStringSchema,
    }),
  ),
});

export const CreateCommitSetSchema = z.object({
  analysisId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  commitIds: z.array(z.string().uuid()).min(1).max(100_000),
});

export const MergeAuthorsSchema = z.object({
  analysisId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320).optional(),
  identityIds: z.array(z.string().uuid()).min(2).max(1_000),
});

export const PaginationSchema = z.object({
  search: z.string().trim().max(500).default(''),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    details: z.unknown().optional(),
  }),
});

export type CloneRepositoryInput = z.infer<typeof CloneRepositorySchema>;
export type Repository = z.infer<typeof RepositorySchema>;
export type MetricsQuery = z.infer<typeof MetricsQuerySchema>;
export type MetricSummary = z.infer<typeof MetricSummarySchema>;
export type MetricsResponse = z.infer<typeof MetricsResponseSchema>;
export type CreateCommitSetInput = z.infer<typeof CreateCommitSetSchema>;
export type MergeAuthorsInput = z.infer<typeof MergeAuthorsSchema>;
