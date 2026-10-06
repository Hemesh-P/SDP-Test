# Repo Analysis Tool

Repo Analysis Tool (RAT) is a TypeScript monorepo for ingesting Git repositories and turning commit history into line-change, churn, ownership, and hotspot dashboards. It follows the no-Docker implementation plan in `.qoder/plans/RAT_Full_Implementation_02f2cc22.md`: native PostgreSQL, Fastify API, `pg-boss` background jobs, Next.js UI, Zod contracts, Drizzle schema definitions, and a streaming Git CLI analyzer.

## Features

- Ingest public HTTPS repositories with full mirror clones and SSRF-resistant URL validation.
- Upload ZIP archives with zip-slip, entry-count, extracted-size, and unsafe `.git` pointer checks.
- Analyze non-merge commits at an immutable reference using Git's rename detection and binary classification.
- Persist repository refs, analyses, commits, author identities, object hierarchy, per-object metrics, daily rollups, saved commit sets, author groups, and progress events.
- Query repository, object, date-range, manual commit-set, and selected-author metrics.
- Merge and unmerge author identities without rewriting commit metrics.
- Browse repositories, filters, KPI cards, activity charts, hotspot charts, manual commit picking, author identity controls, and multi-repository comparisons.
- Validate supplied golden CSV fixtures for cJSON, Redis, and Git.

## Architecture

```text
apps/web      Next.js dashboard and TanStack Query client
apps/api      Fastify REST API, upload handling, validation, OpenAPI, SSE progress
apps/worker   pg-boss consumers for ingest, refresh, analysis, and cleanup
packages/contracts  Shared Zod API contracts
packages/db         Drizzle schema and SQL migration runner
packages/git-analysis  Safe Git process, ZIP handling, parser, analyzer
packages/metrics       Metric formulas and directory propagation
packages/ui            Shared React primitives
```

The API and worker share PostgreSQL for application state and job coordination. Repository storage is kept outside the web app under `REPO_STORAGE_DIR`; temporary uploads live under `UPLOAD_TMP_DIR` and are removed after normalization.

## Prerequisites

Install these natively on Ubuntu or a similar Linux environment:

- Node.js 18.18 or newer
- pnpm 9.x, usually via `corepack enable` then `corepack prepare pnpm@9.15.9 --activate`
- Git
- PostgreSQL 14 or newer

No Docker, Redis service, or analyzed-repository build dependencies are required.

## Configuration

Copy `.env.example` to `.env` and adjust at least `DATABASE_URL` if your local PostgreSQL credentials differ.

Important variables:

- `DATABASE_URL`: PostgreSQL connection string used by API, worker, and migrations.
- `API_HOST`, `API_PORT`, `WEB_ORIGIN`, `NEXT_PUBLIC_API_URL`: local service addresses.
- `REPO_STORAGE_DIR`, `UPLOAD_TMP_DIR`: non-public storage locations.
- `MAX_UPLOAD_BYTES`, `MAX_EXTRACTED_BYTES`, `MAX_ARCHIVE_ENTRIES`: ZIP safety limits.
- `GIT_TIMEOUT_MS`: clone, fetch, and mirror timeout.
- `ANALYSIS_CONCURRENCY`: worker analysis concurrency, default 1.
- `ADMIN_TOKEN`: optional token required for mutating API calls when set; send it as `x-admin-token`.

## Local setup

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

If `pnpm` is not globally enabled, use `npx pnpm ...` for the same commands.

Open the web UI at `http://localhost:3000` and API docs at `http://localhost:4000/docs`.

## Validation commands

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm verify:golden cJSON
RAT_BENCHMARK_SIZES=1000 pnpm benchmark
```

`pnpm verify:golden` with no arguments verifies all supplied fixtures: cJSON, Redis, and Git. Those runs clone large public repositories into `storage/golden`, so use targeted arguments during development.

## Metric definitions

For each non-binary changed file in a selected non-merge commit set:

- Added and removed come from Git numstat.
- Growth is `added - removed`.
- Churn is `added + removed`.
- Directory and root metrics are computed by propagating each changed file's line deltas to every ancestor once per commit.
- Modifications count selected commits where the object has positive churn.
- Modification frequency is `modifications / selected commit count`.
- Churn rate is `churn / selected commit count`.
- Author ownership is selected-author churn divided by total churn for the same object and commit set.

Commit dates use committer time. Date filtering is inclusive at the start and exclusive at the end. Binary numstat entries and submodules are excluded from line metrics but their commits still count in the selected commit set.

## Golden CSV fixtures

The root CSV files are supplied expected outputs for pinned repository states:

- `cJSON_6d9f2443ab07.csv`
- `redis_b540ca49cba8.csv`
- `git_5a7d1e8045ce.csv`

The verification script compares repository-root totals from the streaming parser against each CSV summary row. Lecturer sample values beyond these CSVs are not present in the repository and remain an external input.

## Current limitations

- Playwright and PostgreSQL integration tests are not yet included.
- Benchmarks generate and time synthetic repositories, but published 10k/100k evidence depends on running them on the target machine.
- The UI implements the main flows and responsive layouts, but very large path lists still rely on API limits and search rather than full tree virtualization.
- The project is single-user/local-first; production exposure should set `ADMIN_TOKEN` and a strict CORS origin.

## Submission checklist

- Run the validation commands above from a clean checkout.
- Confirm `.env`, `storage/`, uploaded archives, cloned repositories, and benchmark outputs are not committed.
- Record benchmark results and any unresolved external sample values in `docs/IMPLEMENTATION_STATUS.md`.
- Submit the public repository URL after verifying it can be cloned without authentication.
