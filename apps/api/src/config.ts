import { resolve } from 'node:path';
import { z } from 'zod';

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  REPO_STORAGE_DIR: z.string().default('./storage/repos'),
  UPLOAD_TMP_DIR: z.string().default('./storage/uploads'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(1024 ** 3),
  ADMIN_TOKEN: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
});

export type ApiConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const value = EnvironmentSchema.parse(environment);
  return {
    ...value,
    REPO_STORAGE_DIR: resolve(value.REPO_STORAGE_DIR),
    UPLOAD_TMP_DIR: resolve(value.UPLOAD_TMP_DIR),
  };
}
