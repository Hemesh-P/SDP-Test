import { resolve } from 'node:path';
import { z } from 'zod';

const EnvironmentSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REPO_STORAGE_DIR: z.string().default('./storage/repos'),
  UPLOAD_TMP_DIR: z.string().default('./storage/uploads'),
  MAX_EXTRACTED_BYTES: z.coerce.number().int().positive().default(5 * 1024 ** 3),
  MAX_ARCHIVE_ENTRIES: z.coerce.number().int().positive().default(500_000),
  GIT_TIMEOUT_MS: z.coerce.number().int().positive().default(3_600_000),
  ANALYSIS_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  LOG_LEVEL: z.string().default('info'),
});

export function loadWorkerConfig(environment: NodeJS.ProcessEnv = process.env) {
  const value = EnvironmentSchema.parse(environment);
  return {
    ...value,
    REPO_STORAGE_DIR: resolve(value.REPO_STORAGE_DIR),
    UPLOAD_TMP_DIR: resolve(value.UPLOAD_TMP_DIR),
  };
}
