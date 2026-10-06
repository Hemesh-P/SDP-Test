# Repo Analysis Tool Full Implementation Plan

## Goal and fixed decisions
- Implement the complete scope from [test_brief.pdf](file:///home/vmuser/SDP-Test/test_brief.pdf), targeting the cumulative 100% rubric tier rather than the 2.5-hour minimum.
- Use a TypeScript monorepo: Next.js/React frontend, Fastify API, Node.js analysis worker, PostgreSQL, `pg-boss` for PostgreSQL-backed jobs, native Git CLI, Drizzle ORM, Zod, TanStack Query/Table, Tailwind CSS, Apache ECharts, Vitest, and Playwright.
- Do not use Docker, Redis, or repository-specific build tooling. cJSON, Redis, and Git are analysis datasets only; their source code does not need to be compiled or run.
- Treat the submission target as a public source repository that runs locally. A no-Docker VPS deployment is an optional final step because the brief requires a public repository URL, not a live URL.
- Do not invent the lecturer’s sample commit hashes or expected outputs. Add those as golden fixtures when they are supplied.

## Rubric acceptance matrix
| Area | Completion evidence |
|---|---|
| Repository upload | Safe ZIP upload accepts a working tree containing either a `.git` directory or a valid in-archive `.git` file. |
| Remote ingestion | HTTPS repository URL is fully cloned with all history and refs; no shallow or blob-filtered clone. |
| Multiple repositories | Repository library supports independent ingest, status, analysis, refresh, delete, switching, and comparison. |
| Filtering | Repository, author, file/directory, inclusive-start/exclusive-end committer-date range, and manually selected commits. |
| Author merging | Committed `.mailmap` resolution plus reversible manual grouping of identities. |
| Metrics | File, directory, root repository, commit-set, and author metrics exactly follow the brief. |
| Architecture/UI | Streaming analysis, background jobs, indexed facts and rollups, hierarchical visualizations, responsive accessible UI. |
| Large repositories | A 100,000-commit repository completes without request timeouts or unbounded memory; common dashboard queries meet the targets below. |

## Metric contract
Implement the formulas once in `packages/metrics` and reuse them in SQL/query services and tests.

### Commit-set semantics
- Resolve a selected ref to immutable reference commit `hr` before analysis.
- `H̄` contains every non-merge commit reachable from `hr`; do not use first-parent-only traversal.
- A non-root commit is diffed against its actual single parent, even when that parent is a merge commit. A root commit is diffed against Git’s empty tree.
- `H` is either all of `H̄`, an exact manual subset, or commits whose committer timestamp satisfies `start <= committer_date < end`.
- Use committer date, not author date. Store UTC; convert a user-entered range from the selected UI timezone to UTC before querying.
- Empty commits remain in `|H|`, even though they add no object metric rows.
- The author selector chooses author `a` for the author formulas while total metrics and the ownership denominator continue to use the same `H`. Display the selected author contribution beside the total to avoid making ownership trivially 100%.

### Git diff semantics
- Use Git’s own diff and binary classification through a streaming `git log`/`diff-tree` pipeline with `--no-merges`, `--root`, recursive tree diff, `--find-renames=50%`, NUL-delimited paths, no external diff, and no text conversion.
- Parse output as bytes. Store a lossless path key (`bytea`) and a safely escaped UTF-8 display path so spaces, tabs, Unicode, and unusual Git paths do not corrupt framing.
- Ignore binary numstat entries and gitlinks/submodules when accumulating line metrics. A binary-only commit still counts in `|H|`.
- Attribute a deletion to the old path, a rename with edits to the new path, and a pure rename as zero added/removed/churn. Do not enable copy detection.
- Scan the reachable path history and selected reference tree into the object catalog so unchanged and deleted paths remain selectable; objects with no metrics in `H` return zeros.

### Formulas stored or derived
For each commit `h` and file `f`:
- Added `A(h,f)` and removed `R(h,f)` come directly from Git numstat.
- Growth `G(h,f) = A(h,f) - R(h,f)`.
- Churn `C(h,f) = A(h,f) + R(h,f)`.

For each changed file, propagate added and removed values to every ancestor directory, including root. Aggregate all changed descendants before writing one row per `(commit, object)`. This is equivalent to the brief’s recursive immediate-child directory formula and prevents modification over-counting when several files in one directory change in the same commit.

For selected set `H` and object `o`:
- Added: `sum A(h,o)`.
- Removed: `sum R(h,o)`.
- Growth: `added - removed`.
- Churn: `added + removed`.
- Modifications: count commits where object churn is greater than zero.
- Modification frequency: `modifications / |H|`, or zero when `H` is empty.
- Churn rate: `churn / |H|`, or zero when `H` is empty.
- Repository metrics use the root directory object.

For author `a`:
- Author modifications: modifications from commits whose resolved author is `a`.
- Author churn: churn from those commits.
- Ownership: `author churn / total churn for (H,o)`, or zero when total churn is zero.
- Use PostgreSQL `bigint` for counts. Return counts as decimal strings in JSON to avoid JavaScript integer overflow, and rates as validated finite decimals.

## Monorepo layout
- `apps/web`: Next.js dashboard and client-side data orchestration.
- `apps/api`: Fastify REST API, multipart upload, OpenAPI, SSE progress, validation, and authorization hook for optional deployment protection.
- `apps/worker`: `pg-boss` consumers for clone, ZIP normalization, analysis, rollups, refresh, and cleanup.
- `packages/contracts`: shared Zod request/response schemas and generated API types.
- `packages/db`: Drizzle schema, SQL migrations, repositories, transactions, and query helpers.
- `packages/git-analysis`: safe process spawning, repository validation, ref resolution, mailmap handling, byte-safe stream parser, and Git fixtures.
- `packages/metrics`: formulas, directory propagation, aggregate query builders, and metric response models.
- `packages/ui`: reusable filters, tables, charts, status components, and accessibility primitives.
- `tests/fixtures`: generated synthetic Git histories and later the supplied golden samples.
- `scripts/benchmarks`: deterministic 1k/10k/100k-commit generators and benchmark runner.
- Root configuration: pnpm workspace, strict TypeScript, ESLint, Prettier, Vitest projects, Playwright, `.env.example`, `.gitignore`, and CI workflow.

## Persistence model and indexes
Use UUID application IDs and immutable Git object IDs that support both SHA-1 and SHA-256.

- `repositories`: name, source type, sanitized source URL, storage location, default ref, active analysis, state, timestamps, and last error.
- `repository_refs`: repository, ref name/type, target OID, default flag, and last fetched time.
- `analysis_runs`: repository, resolved reference OID, analyzer version, state/stage, progress totals, timing, error, and active flag.
- `commits`: repository, OID, parent OID, tree OID, raw author identity, committer timestamp, and subject. Unique on repository/OID.
- `analysis_commits`: analysis-to-non-merge-commit reachability membership and stable sequence. This permits ref-specific `H̄` while reusing commit facts.
- `author_identities`: repository-scoped raw name/email pairs.
- `analysis_author_resolution`: raw identity to `.mailmap`-resolved identity for a specific reference.
- `author_groups` and `author_group_members`: user-facing canonical authors and reversible manual merges layered over mailmap resolution.
- `objects`: repository-scoped root/directory/file path, byte path key, display path, parent, depth, and binary observations.
- `commit_object_metrics`: one positive-churn row per commit/object with added and removed counts. File rows and pre-aggregated ancestor directory/root rows share this table.
- `daily_object_author_rollups`: UTC date/object/raw-author added, removed, and modification counts for fast date dashboards; base facts remain authoritative.
- `saved_commit_sets` and `saved_commit_set_members`: named manual selections, ownership, and membership.
- `job_events`: user-readable stage, progress, warnings, and timestamps; `pg-boss` owns queue internals.
- Add composite indexes for `(analysis_id, committer_at)`, `(analysis_id, commit_id)`, `(commit_id, object_id)`, `(object_id, commit_id)`, `(raw_author_id, commit_id)`, object parent/path lookup, rollup date/object/author, and manual-set membership.
- Partition `commit_object_metrics` and rollups by repository or hash partition once benchmark volume justifies it; do not add partition complexity before measured evidence.

## Ingestion and analysis pipeline
1. API validates input, creates the repository/job records, and returns `202 Accepted` immediately.
2. Clone ingestion accepts public HTTPS URLs, sets `GIT_TERMINAL_PROMPT=0`, validates DNS/IP against private and loopback ranges, invokes Git with an argument array rather than a shell, disables unsafe redirects/protocols, and creates `storage/repos/<uuid>.git` with a full mirror clone.
3. ZIP ingestion streams to a bounded temporary file, rejects zip-slip paths, absolute paths, escaping symlinks, excessive entry counts, compression bombs, and configured size limits. Discover repository candidates at bounded depth; automatically choose one or ask the UI to choose if several are valid.
4. Resolve an uploaded `.git` file only when its `gitdir:` target stays inside the extraction root. Normalize either ZIP form into the same private bare-mirror layout, then remove extraction data.
5. Validate with `git rev-parse`, enumerate refs, resolve the selected ref to an immutable commit, and store the default remote HEAD where available.
6. Count reachable non-merge commits first so progress has a denominator.
7. Stream commit metadata and numstat from a constant number of Git processes. Apply Node stream backpressure; never buffer the full history or spawn one process per commit.
8. Parse a batch, upsert commit/author/object facts, aggregate each file change to ancestors, and bulk insert in transactions. Recommended initial batch size: 5,000 metric rows, tuned by benchmark.
9. Resolve `.mailmap` from the selected reference commit, not an arbitrary working tree. Use Git’s mailmap behavior and record raw plus resolved identity; create default author groups without changing metric facts.
10. Build daily rollups and object catalog, run consistency checks (`growth = added - removed`, `churn = added + removed`, root totals equal file totals), then atomically mark the analysis active.
11. On failure, preserve the previous active analysis, record a sanitized actionable error, and allow retry. On cancellation, terminate child Git processes and clean only that job’s temporary data.
12. On refresh, fetch remote refs and analyze a new immutable reference. Reuse existing commit facts by OID; only unseen commits require diff processing.
13. Publish progress at least every two seconds through DB job events and SSE. Stages are queued, validating, acquiring, enumerating, analyzing, rolling up, complete, failed, or cancelled.

## API surface
- `POST /v1/repositories/clone` and `POST /v1/repositories/upload`.
- `GET /v1/repositories`, `GET/PATCH/DELETE /v1/repositories/:id`, and `POST /v1/repositories/:id/refresh`.
- `GET /v1/repositories/:id/refs` and `POST /v1/repositories/:id/analyses` with a validated ref/OID.
- `GET /v1/analyses/:id/events` as SSE, plus status polling fallback.
- Paginated/searchable `GET` endpoints for commits, objects, and authors.
- `POST /v1/commit-sets`, membership update, rename, and delete endpoints.
- `POST /v1/authors/merge` and `POST /v1/authors/unmerge`; changes are transactional and never rewrite commit metrics.
- `POST /v1/metrics/query` with repository/analysis, object, date range or saved manual set, optional author group, grouping, sort, and page fields.
- `POST /v1/metrics/compare` for two to four repositories, returning absolute values and normalized rates.
- Validate every payload with shared Zod schemas, generate OpenAPI, use structured Pino logs with request/job IDs, and return stable machine codes plus safe user messages.

## Dashboard and UX
- Repository library: upload/clone actions, cards/table, current ref, commit count, status, progress, retry, refresh, and confirmed delete.
- Main dashboard: persistent URL-backed repository selector and filter bar; mutually exclusive date/manual commit modes; searchable virtualized commit picker; timezone indicator; author selector; lazy hierarchical file/directory tree.
- KPI cards: added, removed, growth, churn, modifications, modification frequency, churn rate, and selected-author ownership/contribution.
- Visualizations:
  - Stacked added/removed activity timeline with growth overlay.
  - Repository icicle/treemap where area represents churn and color represents signed growth; click to drill into directories.
  - Hotspot ranking by churn, churn rate, modifications, or modification frequency.
  - Author ownership stacked bar/donut and sortable author table.
  - Commit table showing hash, subject, raw/resolved author, committer date, and selected-object contribution.
  - Multi-repository comparison page using rates and per-commit normalization so repositories of different sizes remain comparable.
- Provide metric-definition tooltips, copyable deep links, clear zero/empty states, skeletons, cancellation, retry, keyboard navigation, responsive layouts, color-blind-safe palettes, visible focus, and accessible chart summaries/tables.
- Keep chart point counts bounded through API time buckets and top-N responses; use virtualized lists for large commits/paths.

## Security and operational limits
- Keep clones/uploads outside static web roots and use UUID directories only.
- Initial configurable limits: 1 GB ZIP, 5 GB extracted data, 500,000 archive entries, 60-minute clone, 60-minute analysis stage, and one analysis per repository. Set limits high enough for the three supplied test repositories and document overrides.
- Limit global worker concurrency based on CPU/disk; start at one analysis worker and benchmark before increasing.
- Apply API body/rate limits, MIME plus content inspection, CORS allow-list, secure headers, and optional environment-based admin token for mutation endpoints when publicly deployed.
- Never place credentials in repository URLs or logs. Redact URL user-info, command stderr secrets, filesystem paths, and stack traces from client responses.
- Deletion removes DB data transactionally and schedules filesystem cleanup; provide explicit confirmation and protect active jobs.

## Verification plan
### Deterministic metric fixtures
Generate temporary Git repositories in tests and set author, author date, and committer date explicitly. Cover:
- Root commit against empty tree; add/edit/delete; empty commit.
- Nested directories and multiple files changed in one commit.
- Pure rename, rename plus edit, and similarity below 50%.
- Binary files, gitlinks, line-ending changes, files without final newline.
- Merge exclusion, non-merge child of a merge, branches, and reference reachability.
- Exact inclusive start and exclusive end timestamp boundaries.
- `.mailmap`, no mailmap, manual merge, unmerge, and same person with multiple identities.
- Paths with spaces, tabs, Unicode, and deleted/reintroduced paths.
- Empty `H`, one-commit `H`, arbitrary manual sets, and all rate zero-denominator cases.

### Test layers
- Unit tests for byte parser, formulas, ancestor aggregation, URL/archive validation, and author resolution.
- PostgreSQL integration tests for migrations, idempotent reanalysis, filtering, rollups versus base facts, concurrency, retries, and deletion.
- API contract tests for all success/error states and pagination.
- Playwright flows for URL clone, ZIP upload, progress, filters, commit selection, author merge, repository switching/comparison, and responsive/accessibility behavior.
- Golden tests for cJSON, Redis, and Git at the exact lecturer-provided reference hashes and sample values. Store only hashes and expected metrics, not cloned repositories.
- Security tests for malformed archives, zip slip, unsafe `.git` pointers, command injection strings, SSRF hosts, oversized input, and client error redaction.
- CI gates: formatting, lint, strict typecheck, unit/integration tests, production builds, Playwright smoke test, migrations from empty DB, and metric-package coverage of at least 90% branches.

### Performance targets
Document hardware and dataset characteristics with every result. On a baseline 4-vCPU, 16-GB RAM SSD machine:
- Analyze 1,000 commits in at most 30 seconds, 10,000 in at most 3 minutes, and 100,000 in at most 25 minutes after clone; treat changed-file volume as an additional reported variable.
- Keep worker peak RSS below 1.5 GB and prove that memory does not grow linearly with commit count.
- Common cached dashboard queries: p95 at most 300 ms; cold grouped/hotspot queries: p95 at most 2 seconds.
- API status/progress response: p95 at most 200 ms; progress visible within two seconds.
- Main dashboard usable within two seconds after metric data arrives and interactions remain responsive with 100,000 commits via pagination/virtualization.
- Benchmark failures trigger profiling and evidence-based indexing/batching/rollup changes; do not weaken metric semantics for speed.

## Implementation sequence and exit gates
### Phase 0 — Manual prerequisites
1. Install current Node.js LTS, enable Corepack/pnpm, install Git, and install PostgreSQL natively on Ubuntu. Confirm `node`, `pnpm`, `git`, `psql`, and `pg_isready` work.
2. Create a local PostgreSQL role/database for RAT. Keep the password only in local environment configuration.
3. Obtain the lecturer’s sample commit hashes and expected metrics when available.
4. Create an empty public GitHub repository for final submission; do not push secrets, uploaded ZIPs, clones, database files, or generated benchmark repositories.
5. Check the course AI policy and prepare an accurate AI-assistance declaration if required.

Exit: native dependencies work without Docker and external information still missing is recorded explicitly.

### Phase 1 — Workspace foundation
1. Replace the placeholder root setup with the pnpm monorepo and strict shared tooling.
2. Scaffold web, API, worker, contracts, DB, Git-analysis, metrics, and UI packages.
3. Add typed environment validation, health endpoints, structured logging, `.env.example`, and a non-secret storage directory configuration.
4. Add CI using the Ubuntu runner’s native PostgreSQL service; do not add Dockerfiles or Compose.

Exit: one command runs all development services, and lint/typecheck/test/build pass.

### Phase 2 — Database and job lifecycle
1. Implement schema, constraints, migrations, indexes, seed-free startup, and repository transactions.
2. Configure `pg-boss`, worker heartbeat, retry/cancel behavior, job event persistence, and atomic active-analysis switching.
3. Add repository/job CRUD API and a minimal status UI.

Exit: a synthetic job survives API restart, reports progress, retries safely, and can be cancelled.

### Phase 3 — Both ingestion paths
1. Implement safe full mirror clone and URL protections.
2. Implement bounded ZIP streaming, extraction validation, candidate discovery, `.git` file resolution, and bare-mirror normalization.
3. Add ref enumeration, default-ref resolution, cleanup, refresh, and deletion.
4. Test with small local fixtures before cJSON; do not start with Redis or Git.

Exit: both inputs produce an equivalent validated bare repository and failures are actionable.

### Phase 4 — Metric engine correctness
1. Build byte-safe streaming Git parser and synthetic history generator.
2. Persist commit facts, object catalog, file metrics, and deduplicated ancestor aggregates.
3. Implement root, date/manual commit-set, rates, and author formulas.
4. Add mailmap-at-reference resolution and invariant checks.
5. Run all deterministic fixture cases before building charts.

Exit: every formula and Git edge case has a passing expected-value test.

### Phase 5 — Query API and author merging
1. Implement filter/query planner, rollups, pagination, time bucketing, hotspot and comparison queries.
2. Implement saved manual commit sets and membership validation.
3. Implement reversible manual author groups over mailmap identities.
4. Cross-check rollup results against base-fact queries and explain query plans for large paths.

Exit: API returns correct totals for every filter combination and manual merging changes only author views.

### Phase 6 — Full dashboard
1. Build repository library and ingest dialogs with progress/retry/cancel.
2. Build URL-backed filters, commit picker, author/object selectors, KPI cards, charts, tree drill-down, tables, and compare page.
3. Add responsive, keyboard, empty/loading/error, and accessible alternatives.

Exit: all Playwright user journeys pass at desktop and mobile viewport sizes.

### Phase 7 — Large-repository hardening
1. Run cJSON first, then Redis, then Git at pinned hashes.
2. Run synthetic 1k/10k/100k benchmarks and capture commit count, changed files, metric rows, duration, throughput, peak RSS, DB size, and query p50/p95.
3. Tune batches/indexes/rollups only from profiles; test crash recovery, disk-full messaging, stale jobs, refresh reuse, and concurrent browsing during analysis.
4. Verify counts against independent Git commands and the lecturer’s golden values.

Exit: correctness is unchanged, the 100k run finishes within resource targets, and benchmark evidence is reproducible.

### Phase 8 — Submission readiness
1. Write the root README with problem statement, no-Docker setup, commands, architecture diagram, metric definitions, edge-case decisions, screenshots, API link, benchmark table, test commands, limitations, and accurate AI declaration.
2. Include `.env.example`, migration/run scripts, sample screenshots, and a rubric-to-evidence checklist.
3. Run a clean-machine rehearsal from a fresh clone and empty database.
4. Run the complete CI suite, inspect `git status`, verify no secrets/large clones are tracked, and manually make the GitHub repository public.
5. Submit the exact public repository URL and verify it works in a logged-out browser.

Exit: a marker can clone the public repository, follow only the README, ingest both source types, reproduce tests, and inspect benchmark evidence without Docker.

## Optional no-Docker live deployment
- Use one Ubuntu VPS so API, worker, and repository storage share a filesystem. Install Node.js, pnpm, Git, PostgreSQL, Nginx, and Certbot natively.
- Create a dedicated unprivileged `rat` user, `/var/lib/rat/repos` storage, production DB/user, and restricted environment file.
- Build once, run web/API/worker as separate `systemd` services with restart policies and resource limits, and proxy through Nginx with TLS.
- Enable the admin token for mutation endpoints, firewall all ports except SSH/HTTP/HTTPS, configure PostgreSQL and repository-storage backups, and test restore/cancellation/disk monitoring.
- Do this only after local correctness. A live deployment is not required by the stated submission rule.

## Cross-chat handoff process
- Maintain `docs/IMPLEMENTATION_STATUS.md` from Phase 1 onward. At every phase boundary record completed checklist items, current branch/commit, changed files, schema/API decisions, exact validation commands and results, unresolved issues, and the next three actions.
- When chat context approaches 45–50%, stop after the nearest atomic task, run the relevant validation, update the status file, and have the user create a normal checkpoint commit if desired.
- Start the next chat with: “Read the saved RAT implementation plan and `docs/IMPLEMENTATION_STATUS.md`, inspect `git status` and recent commits, then continue from the first incomplete exit gate. Do not redo completed work.”
- Never rely on prior chat memory for a decision that is not recorded in the repository.

## Assumptions and pending external inputs
- The app is single-user/local-first because authentication is not required by the brief; optional deployment protection covers public exposure.
- HTTPS clone support is sufficient for the supplied public repositories. Private-repository credential management is out of scope.
- The supplied sample hashes/expected values are not present in the brief or attachments and must be obtained before golden validation.
- Repository contents are analyzed, not executed. No cJSON, Redis, or Git build dependencies are needed.