# RAT Implementation Status

## Snapshot

- Branch: `main`
- Plan: `.qoder/plans/RAT_Full_Implementation_02f2cc22.md`
- Architecture: TypeScript pnpm monorepo with Next.js web app, Fastify API, PostgreSQL, pg-boss worker, Drizzle schema, Git CLI analyzer, Zod contracts, and Vitest.
- External dependencies required locally: Node.js, pnpm, Git, PostgreSQL. Docker and Redis are intentionally not required.

## Completed checklist

### Phase 1 — Workspace foundation

- pnpm workspace is configured for `apps/*` and `packages/*`.
- Strict shared TypeScript, ESLint, Prettier, and Vitest configuration are present.
- API and worker environment validation is implemented.
- Health endpoint and OpenAPI UI are available in the API service.
- `.env.example` documents local runtime configuration.
- CI workflow added at `.github/workflows/ci.yml` (native PostgreSQL service, no Docker): install, lint, typecheck, unit tests, build, golden verification, and 1k benchmark, with benchmark results uploaded as an artifact.

### Phase 2 — Database and job lifecycle

- Initial migration creates repositories, refs, analyses, commits, author identities, object hierarchy, metrics, rollups, saved commit sets, author groups, and job events.
- `pg-boss` is configured by the API and worker for ingest, refresh, analysis, and delete jobs.
- Repository CRUD, refresh, and progress event persistence are implemented.
- Active analysis is switched only after the worker finishes analysis and consistency checks.

### Phase 3 — Ingestion paths

- HTTPS clone ingestion uses full mirror clones and disables terminal prompts, local protocol, and HTTP redirects.
- URL validation rejects credentials, non-HTTPS URLs, non-standard ports, and non-public DNS results.
- ZIP ingestion validates archive paths, entry counts, extracted size, links/special entries, and `.git` file targets.
- Uploaded repositories are normalized into private bare mirrors and temporary extraction data is removed.

### Phase 4 — Metric engine correctness

- Git history parsing streams `git log --numstat -z` output, excludes merge commits, includes root commits, and uses rename detection.
- Binary entries are excluded from line totals while commits remain in the selected set.
- Submodule (gitlink) pointer changes are counted exactly as Git's own numstat reports them (one line per pointer change). This was corrected this session: the previous `--ignore-submodules=all` flag caused the git golden fixture to under-count by 4 added / 3 removed lines on the `sha1collisiondetection` submodule.
- File metrics are propagated to ancestor directories and repository root.
- Raw and mailmap-resolved author identities are stored per analysis.
- Daily rollups are rebuilt after analysis.
- Unit tests cover core formula behavior, representative Git history parsing, and security controls (SSRF/URL validation, `.git` pointer escape, shell-metacharacter injection, and Git output byte caps).

### Phase 5 — Query API and author merging

- Metrics query supports all commits, date ranges, manual saved commit sets, object filtering, author group filtering, and time/object/author grouping.
- Saved commit sets can be listed, created, renamed or membership-updated, and deleted.
- Manual author merge and unmerge operations are transactional and preserve underlying commit metrics.
- Compare API accepts two to four metric queries.

### Phase 6 — Dashboard

- Repository library supports clone, ZIP upload, progress polling, refresh, delete, and repository navigation.
- Repository dashboard supports commit-set mode, date mode, manual commit picking, object search, author selection, KPI cards, activity chart, hotspot chart, and author merging.
- Comparison page presents normalized per-commit rates across selected ready repositories.
- Loading, empty, and error states are implemented for the primary flows.

### Phase 7 — Large-repository hardening

- `scripts/verify-golden.ts` validates supplied cJSON, Redis, and Git CSV repository-root metrics.
- `scripts/benchmarks/run.ts` generates deterministic synthetic repositories and records analysis throughput and peak RSS to `storage/benchmark-results.json`.

### Phase 8 — Submission readiness

- Root README documents architecture, no-Docker setup, configuration, validation commands, metric definitions, fixtures, limitations, and submission checklist.
- This status file records completed items, validation commands, current limitations, and next actions for cross-chat handoff.

## Validation log (this session)

Environment: Node 18.19.1, Git 2.43.0, no global pnpm (`npx pnpm`), PostgreSQL not installed natively.

- `npx pnpm -C /home/vmuser/SDP-Test typecheck` — passed (all 8 projects).
- `npx pnpm -C /home/vmuser/SDP-Test lint` — passed (`--max-warnings 0`).
- `npx pnpm -C /home/vmuser/SDP-Test test` — passed; 3 test files, 21 tests (added 14 security tests).
- `npx pnpm -C /home/vmuser/SDP-Test build` — passed, including the Next.js production build.
- `npx pnpm -C /home/vmuser/SDP-Test verify:golden` — passed for **all three** fixtures (root metrics match exactly):
  - cJSON: 955 commits, +46,377 / −11,211, churn 57,588, 953 modifications.
  - Redis: 11,874 commits, +1,110,258 / −500,312, churn 1,610,570, 11,862 modifications.
  - Git: 61,101 commits, +4,070,371 / −2,375,604, churn 6,445,975, 61,009 modifications.
- `RAT_BENCHMARK_SIZES=1000 npx pnpm -C /home/vmuser/SDP-Test benchmark` — passed and wrote `storage/benchmark-results.json`: 1,000 commits streamed/parsed in ~0.17s, peak RSS ~108 MB (targets: ≤30s and ≤1.5 GB). Synthetic-repo generation (1,000 `git commit` invocations) took ~14s.
- Embedded PostgreSQL 16.14 was validated to boot and serve queries in this environment via the `embedded-postgres` dev dependency, providing a Docker-free path to run the API/worker/database runtime and future PostgreSQL integration tests without a native install.

Recommended final submission commands:

```bash
npx pnpm -C /home/vmuser/SDP-Test typecheck
npx pnpm -C /home/vmuser/SDP-Test lint
npx pnpm -C /home/vmuser/SDP-Test test
npx pnpm -C /home/vmuser/SDP-Test build
npx pnpm -C /home/vmuser/SDP-Test verify:golden
RAT_BENCHMARK_SIZES=1000 npx pnpm -C /home/vmuser/SDP-Test benchmark
```

## Unresolved issues and limitations

- PostgreSQL-backed integration tests and Playwright browser tests are scaffolded-for but not yet committed. `embedded-postgres` is installed and proven to boot, so integration tests can run without Docker or a native PostgreSQL install; wiring them into a `test:integration` Vitest project is the immediate next step.
- Published 10k and 100k benchmark evidence has not yet been generated; 1k evidence is recorded in `storage/benchmark-results.json`.
- Lecturer sample hashes and expected values beyond the supplied CSV fixtures are not present. The supplied golden CSVs also contain per-object and per-author rows that the current verifier does not assert (it checks the repository-root ALL row); extending verification to those rows is future work.
- Public GitHub repository creation and final URL submission are external manual steps.
- Global `pnpm` is not installed in the current shell; `npx pnpm` works.
- Very large path lists in the UI rely on API limits/search rather than full tree virtualization.

## Next three actions

1. Commit the integration-test harness: a `test:integration` Vitest project that boots `embedded-postgres`, runs migrations, analyzes a synthetic repository, and asserts persistence, metric totals, rollups, idempotent reanalysis, and delete cascades.
2. Add Playwright smoke tests for clone/upload, progress, filtering, and comparison flows.
3. Generate and record 10k/100k benchmark evidence on the target hardware before final submission.
