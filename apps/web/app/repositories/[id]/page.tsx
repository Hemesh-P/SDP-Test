'use client';

import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarRange,
  Check,
  ChevronRight,
  GitCommitHorizontal,
  Search,
  Users,
} from 'lucide-react';
import type { MetricsQuery } from '@rat/contracts';
import {
  Badge,
  Button,
  Card,
  ErrorNotice,
  Loading,
  MetricCard,
  formatCount,
  formatPercent,
} from '@rat/ui';
import { ActivityChart, HotspotChart } from '../../../components/metric-chart';
import { CommitPicker } from '../../../components/commit-picker';
import {
  createCommitSet,
  getMetrics,
  getRepository,
  listAuthors,
  listCommitSets,
  listCommits,
  listObjects,
  mergeAuthors,
  unmergeAuthor,
} from '../../../lib/api';

export default function RepositoryDashboard({ params }: { params: { id: string } }) {
  const client = useQueryClient();
  const [mode, setMode] = useState<'all' | 'date' | 'manual'>('all');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [objectSearch, setObjectSearch] = useState('');
  const [objectId, setObjectId] = useState<string>();
  const [objectLabel, setObjectLabel] = useState('/');
  const [authorId, setAuthorId] = useState<string>();
  const [selectedCommits, setSelectedCommits] = useState<Set<string>>(new Set());
  const [commitSetId, setCommitSetId] = useState<string>();
  const [mergeSelection, setMergeSelection] = useState<Set<string>>(new Set());
  const [mergeName, setMergeName] = useState('');

  const repository = useQuery({
    queryKey: ['repository', params.id],
    queryFn: () => getRepository(params.id),
    refetchInterval: (query) =>
      query.state.data?.state === 'ready' || query.state.data?.state === 'failed' ? false : 2_000,
  });
  const analysisId = repository.data?.activeAnalysisId;
  const authors = useQuery({
    queryKey: ['authors', analysisId],
    queryFn: () => listAuthors(analysisId!),
    enabled: Boolean(analysisId),
  });
  const objects = useQuery({
    queryKey: ['objects', params.id, objectSearch],
    queryFn: () => listObjects(params.id, objectSearch),
    enabled: repository.data?.state === 'ready',
  });
  const commits = useQuery({
    queryKey: ['commits', analysisId],
    queryFn: () => listCommits(analysisId!),
    enabled: Boolean(analysisId) && mode === 'manual',
  });
  const commitSets = useQuery({
    queryKey: ['commit-sets', analysisId],
    queryFn: () => listCommitSets(analysisId!),
    enabled: Boolean(analysisId) && mode === 'manual',
  });

  const commitFilter = useMemo<MetricsQuery['commits']>(() => {
    if (mode === 'date') {
      return {
        mode: 'date',
        ...(start ? { start: new Date(start).toISOString() } : {}),
        ...(end ? { end: new Date(end).toISOString() } : {}),
      };
    }
    if (mode === 'manual' && commitSetId) return { mode: 'manual', commitSetId };
    return { mode: 'all' };
  }, [commitSetId, end, mode, start]);

  const baseQuery = useMemo<MetricsQuery | null>(
    () =>
      analysisId
        ? {
            analysisId,
            ...(objectId ? { objectId } : {}),
            ...(authorId ? { authorGroupId: authorId } : {}),
            commits: commitFilter,
            groupBy: 'day',
            limit: 120,
          }
        : null,
    [analysisId, authorId, commitFilter, objectId],
  );
  const metrics = useQuery({
    queryKey: ['metrics', baseQuery],
    queryFn: () => getMetrics(baseQuery!),
    enabled: Boolean(baseQuery) && (mode !== 'manual' || Boolean(commitSetId)),
  });
  const hotspots = useQuery({
    queryKey: ['hotspots', baseQuery],
    queryFn: () => getMetrics({ ...baseQuery!, groupBy: 'object', limit: 40 }),
    enabled: Boolean(baseQuery) && (mode !== 'manual' || Boolean(commitSetId)),
  });

  const saveCommitSet = useMutation({
    mutationFn: () =>
      createCommitSet({
        analysisId: analysisId!,
        name: `Selection ${new Date().toLocaleString()}`,
        commitIds: [...selectedCommits],
      }),
    onSuccess: async (created) => {
      setCommitSetId(created.id);
      await client.invalidateQueries({ queryKey: ['commit-sets', analysisId] });
    },
  });
  const merge = useMutation({
    mutationFn: () => {
      const identities = (authors.data?.items ?? [])
        .filter((author) => mergeSelection.has(author.id))
        .flatMap((author) => author.identityIds);
      return mergeAuthors({ analysisId: analysisId!, name: mergeName, identityIds: identities });
    },
    onSuccess: async () => {
      setMergeSelection(new Set());
      setMergeName('');
      await client.invalidateQueries({ queryKey: ['authors', analysisId] });
      await client.invalidateQueries({ queryKey: ['metrics'] });
    },
  });
  const unmerge = useMutation({
    mutationFn: unmergeAuthor,
    onSuccess: () => client.invalidateQueries({ queryKey: ['authors', analysisId] }),
  });
  const toggleCommit = useCallback((id: string) => {
    setSelectedCommits((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setCommitSetId(undefined);
  }, []);

  if (repository.isLoading)
    return (
      <main className="mx-auto max-w-[1500px] p-8">
        <Loading label="Loading repository" />
      </main>
    );
  if (repository.error || !repository.data)
    return (
      <main className="mx-auto max-w-[1500px] p-8">
        <ErrorNotice message={repository.error?.message ?? 'Repository not found'} />
      </main>
    );
  const repo = repository.data;
  if (repo.state !== 'ready' || !analysisId) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <Link
          className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white"
          href="/"
        >
          <ArrowLeft className="h-4 w-4" /> Repositories
        </Link>
        <Card className="mt-6 text-center">
          <Loading label={repo.progressStage ?? `Repository is ${repo.state}`} />
          <div className="mx-auto mt-4 h-2 max-w-md overflow-hidden rounded-full bg-slate-800">
            <div className="h-full bg-cyan-400" style={{ width: `${repo.progress * 100}%` }} />
          </div>
          {repo.lastError ? (
            <div className="mt-5">
              <ErrorNotice message={repo.lastError} />
            </div>
          ) : null}
        </Card>
      </main>
    );
  }

  const summary = metrics.data?.summary;
  return (
    <main className="mx-auto max-w-[1600px] px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-white"
            href="/"
          >
            <ArrowLeft className="h-4 w-4" /> Repositories
          </Link>
          <h1 className="mt-3 text-3xl font-semibold text-white">{repo.name}</h1>
          <p className="mt-2 flex items-center gap-2 font-mono text-sm text-slate-500">
            <GitCommitHorizontal className="h-4 w-4" /> {repo.defaultRef} ·{' '}
            {repo.commitCount.toLocaleString()} commits
          </p>
        </div>
        <Badge tone="good">Analysis ready</Badge>
      </div>

      <Card className="mt-8">
        <div className="grid gap-4 lg:grid-cols-[auto_1fr_1fr_1fr] lg:items-end">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Commit set
            </p>
            <div className="flex rounded-lg bg-slate-950 p-1">
              {(['all', 'date', 'manual'] as const).map((item) => (
                <button
                  className={`focus-ring rounded-md px-3 py-2 text-sm ${mode === item ? 'bg-slate-800 text-white' : 'text-slate-500'}`}
                  key={item}
                  onClick={() => setMode(item)}
                  type="button"
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
          {mode === 'date' ? (
            <>
              <label className="text-sm text-slate-400">
                From (inclusive)
                <input
                  className="mt-2 block w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-white"
                  onChange={(event) => setStart(event.target.value)}
                  type="datetime-local"
                  value={start}
                />
              </label>
              <label className="text-sm text-slate-400">
                Until (exclusive)
                <input
                  className="mt-2 block w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-white"
                  onChange={(event) => setEnd(event.target.value)}
                  type="datetime-local"
                  value={end}
                />
              </label>
            </>
          ) : (
            <div className="text-sm text-slate-500 lg:col-span-2">
              {mode === 'all'
                ? 'All reachable non-merge commits'
                : commitSetId
                  ? `${selectedCommits.size} selected commits applied`
                  : 'Choose commits below, then apply the set'}
            </div>
          )}
          <div className="text-right text-xs text-slate-500">
            <CalendarRange className="mr-1 inline h-4 w-4" /> Times interpreted in your local
            timezone
          </div>
        </div>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <label className="text-sm text-slate-400">
            Object
            <div className="relative mt-2">
              <Search className="absolute left-3 top-3 h-4 w-4 text-slate-600" />
              <input
                className="w-full rounded-lg border border-slate-700 bg-slate-950 py-2.5 pl-9 pr-3 text-white"
                onChange={(event) => setObjectSearch(event.target.value)}
                placeholder="Search files and directories"
                value={objectSearch}
              />
            </div>
            <select
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 p-2.5 text-white"
              onChange={(event) => {
                const selected = objects.data?.items.find((item) => item.id === event.target.value);
                setObjectId(selected?.id);
                setObjectLabel(selected?.path ?? '/');
              }}
              value={objectId ?? ''}
            >
              <option value="">/ (repository root)</option>
              {objects.data?.items
                .filter((item) => item.kind !== 'root')
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.kind === 'directory' ? '▸ ' : ''}
                    {item.path}
                  </option>
                ))}
            </select>
          </label>
          <label className="text-sm text-slate-400">
            Author contribution
            <select
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 p-2.5 text-white"
              onChange={(event) => setAuthorId(event.target.value || undefined)}
              value={authorId ?? ''}
            >
              <option value="">All authors</option>
              {authors.data?.items.map((author) => (
                <option key={author.id} value={author.id}>
                  {author.name} {author.email ? `<${author.email}>` : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Card>

      {mode === 'manual' ? (
        <Card className="mt-6">
          <div className="mb-4 flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
            <div>
              <h2 className="font-semibold text-white">Manual commit set</h2>
              <p className="text-sm text-slate-500">
                Select any commits reachable from the analyzed reference or reuse a saved set.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <select
                className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-white"
                onChange={(event) => setCommitSetId(event.target.value || undefined)}
                value={commitSetId ?? ''}
              >
                <option value="">Unsaved selection</option>
                {commitSets.data?.items.map((set) => (
                  <option key={set.id} value={set.id}>
                    {set.name} · {set.commitCount} commits
                  </option>
                ))}
              </select>
              <Button
                disabled={!selectedCommits.size || saveCommitSet.isPending}
                onClick={() => saveCommitSet.mutate()}
              >
                <Check className="h-4 w-4" /> Save and apply {selectedCommits.size || ''}
              </Button>
            </div>
          </div>
          {commits.isLoading ? (
            <Loading label="Loading commits" />
          ) : (
            <CommitPicker
              commits={commits.data?.items ?? []}
              onToggle={toggleCommit}
              selected={selectedCommits}
            />
          )}
          {saveCommitSet.error ? (
            <div className="mt-3">
              <ErrorNotice message={saveCommitSet.error.message} />
            </div>
          ) : null}
        </Card>
      ) : null}

      <div className="mt-6 flex items-center gap-2 text-sm text-slate-500">
        <span>Scope</span>
        <ChevronRight className="h-4 w-4" />
        <span className="font-mono text-cyan-300">{objectLabel}</span>
      </div>
      {metrics.isLoading ? <Loading label="Calculating metrics" /> : null}
      {metrics.error ? (
        <div className="mt-5">
          <ErrorNotice message={metrics.error.message} onRetry={() => metrics.refetch()} />
        </div>
      ) : null}
      {summary ? (
        <>
          <section
            className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
            aria-label="Metric summary"
          >
            <MetricCard
              label="Added lines"
              value={`+${formatCount(summary.added)}`}
              detail="Across selected commits"
            />
            <MetricCard
              label="Removed lines"
              value={`−${formatCount(summary.removed)}`}
              detail="Binary files excluded"
            />
            <MetricCard
              label="Net growth"
              value={formatCount(summary.growth)}
              detail="Added minus removed"
            />
            <MetricCard
              label="Churn"
              value={formatCount(summary.churn)}
              detail={`${formatCount(summary.modifications)} modifications`}
            />
            <MetricCard
              label="Modification frequency"
              value={formatPercent(summary.modificationFrequency)}
              detail="Modified commits ÷ commit set"
            />
            <MetricCard
              label="Churn rate"
              value={summary.churnRate.toFixed(2)}
              detail="Changed lines per commit"
            />
            <MetricCard
              label="Commits in set"
              value={formatCount(summary.commitCount)}
              detail="Non-merge commits"
            />
            <MetricCard
              label="Author ownership"
              value={summary.author ? formatPercent(summary.author.ownership) : '—'}
              detail={
                summary.author
                  ? `${formatCount(summary.author.churn)} lines of churn`
                  : 'Select an author'
              }
            />
          </section>
          <section className="mt-6 grid gap-6 xl:grid-cols-2">
            <ActivityChart series={metrics.data?.series ?? []} />
            <HotspotChart series={hotspots.data?.series ?? []} />
          </section>
        </>
      ) : null}

      <Card className="mt-6">
        <div className="flex items-center gap-3">
          <Users className="h-5 w-5 text-cyan-300" />
          <div>
            <h2 className="font-semibold text-white">Author identities</h2>
            <p className="text-sm text-slate-500">
              Mailmap identities are resolved automatically. Select two or more groups to merge
              manually.
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {authors.data?.items.map((author) => (
            <label
              className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3"
              key={author.id}
            >
              <input
                checked={mergeSelection.has(author.id)}
                onChange={() =>
                  setMergeSelection((current) => {
                    const next = new Set(current);
                    if (next.has(author.id)) next.delete(author.id);
                    else next.add(author.id);
                    return next;
                  })
                }
                type="checkbox"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-white">{author.name}</span>
                <span className="block truncate text-xs text-slate-500">
                  {author.email ?? 'No email'} · {author.identities} identity
                </span>
              </span>
              {author.isManual ? (
                <button
                  className="text-xs text-rose-300"
                  onClick={() => unmerge.mutate(author.id)}
                  type="button"
                >
                  Unmerge
                </button>
              ) : null}
            </label>
          ))}
        </div>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            className="min-h-10 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 text-white"
            onChange={(event) => setMergeName(event.target.value)}
            placeholder="Merged author name"
            value={mergeName}
          />
          <Button
            disabled={mergeSelection.size < 2 || !mergeName || merge.isPending}
            onClick={() => merge.mutate()}
          >
            Merge selected authors
          </Button>
        </div>
        {merge.error ? (
          <div className="mt-3">
            <ErrorNotice message={merge.error.message} />
          </div>
        ) : null}
      </Card>
    </main>
  );
}
