'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Clock3, GitFork, Plus, RefreshCw, Trash2, UploadCloud } from 'lucide-react';
import { Badge, Button, Card, ErrorNotice, Loading } from '@rat/ui';
import {
  cloneRepository,
  deleteRepository,
  listRepositories,
  refreshRepository,
  uploadRepository,
} from '../lib/api';

function stateTone(state: string): 'neutral' | 'good' | 'warn' | 'bad' {
  if (state === 'ready') return 'good';
  if (state === 'failed' || state === 'cancelled') return 'bad';
  if (state === 'queued') return 'neutral';
  return 'warn';
}

export default function RepositoriesPage() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'clone' | 'upload'>('clone');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('https://github.com/DaveGamble/cJSON.git');
  const [file, setFile] = useState<File | null>(null);
  const repositories = useQuery({
    queryKey: ['repositories'],
    queryFn: listRepositories,
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => !['ready', 'failed', 'cancelled'].includes(item.state)) ? 2_000 : false,
  });
  const create = useMutation({
    mutationFn: async () => {
      if (mode === 'clone') return cloneRepository({ name, url });
      if (!file) throw new Error('Choose a ZIP archive first');
      return uploadRepository(name, file);
    },
    onSuccess: async () => {
      setName('');
      setFile(null);
      await queryClient.invalidateQueries({ queryKey: ['repositories'] });
    },
  });
  const remove = useMutation({
    mutationFn: deleteRepository,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['repositories'] }),
  });
  const refresh = useMutation({
    mutationFn: refreshRepository,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['repositories'] }),
  });

  const summary = useMemo(() => {
    const items = repositories.data?.items ?? [];
    return {
      total: items.length,
      commits: items.reduce((sum, item) => sum + item.commitCount, 0),
      active: items.filter((item) => !['ready', 'failed', 'cancelled'].includes(item.state)).length,
    };
  }, [repositories.data]);

  return (
    <main className="mx-auto max-w-[1500px] px-4 py-10 sm:px-6 lg:px-8">
      <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-cyan-400">Workspace</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-white">Repository intelligence</h1>
          <p className="mt-3 max-w-2xl text-slate-400">
            Turn Git history into measurable ownership, volatility, and growth signals.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {[
            ['Repositories', summary.total],
            ['Commits', summary.commits.toLocaleString()],
            ['Active jobs', summary.active],
          ].map(([label, value]) => (
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-3" key={String(label)}>
              <p className="text-xs text-slate-500">{label}</p>
              <p className="mt-1 font-mono text-lg text-white">{value}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-10 grid gap-6 xl:grid-cols-[380px_1fr]">
        <Card className="h-fit">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-400/10 text-cyan-300">
              <Plus className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="font-semibold text-white">Add repository</h2>
              <p className="text-sm text-slate-500">Full history, analyzed in the background</p>
            </div>
          </div>
          <div className="mt-6 grid grid-cols-2 rounded-lg bg-slate-950 p-1" role="tablist">
            {(['clone', 'upload'] as const).map((item) => (
              <button
                className={`focus-ring rounded-md px-3 py-2 text-sm font-medium ${mode === item ? 'bg-slate-800 text-white' : 'text-slate-500'}`}
                key={item}
                onClick={() => setMode(item)}
                role="tab"
                type="button"
              >
                {item === 'clone' ? 'Clone URL' : 'Upload ZIP'}
              </button>
            ))}
          </div>
          <form
            className="mt-5 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <label className="block text-sm text-slate-300">
              Display name
              <input
                className="focus-ring mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white"
                onChange={(event) => setName(event.target.value)}
                placeholder="My project"
                required
                value={name}
              />
            </label>
            {mode === 'clone' ? (
              <label className="block text-sm text-slate-300">
                Public HTTPS URL
                <input
                  className="focus-ring mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 font-mono text-sm text-white"
                  onChange={(event) => setUrl(event.target.value)}
                  required
                  type="url"
                  value={url}
                />
              </label>
            ) : (
              <label className="block text-sm text-slate-300">
                Repository ZIP
                <input
                  accept=".zip,application/zip"
                  className="focus-ring mt-2 block w-full rounded-lg border border-dashed border-slate-700 bg-slate-950 p-4 text-sm"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  required
                  type="file"
                />
              </label>
            )}
            {create.error ? <ErrorNotice message={create.error.message} /> : null}
            <Button className="w-full" disabled={create.isPending || !name} type="submit">
              {mode === 'clone' ? <GitFork className="h-4 w-4" /> : <UploadCloud className="h-4 w-4" />}
              {create.isPending ? 'Submitting…' : mode === 'clone' ? 'Clone and analyze' : 'Upload and analyze'}
            </Button>
          </form>
        </Card>

        <section aria-labelledby="repository-list-title">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white" id="repository-list-title">Repositories</h2>
            <button className="focus-ring rounded-lg p-2 text-slate-400 hover:bg-slate-800" onClick={() => repositories.refetch()} type="button">
              <RefreshCw className="h-4 w-4" aria-label="Refresh repositories" />
            </button>
          </div>
          {repositories.isLoading ? <Loading label="Loading repositories" /> : null}
          {repositories.error ? <ErrorNotice message={repositories.error.message} onRetry={() => repositories.refetch()} /> : null}
          {repositories.data?.items.length === 0 ? (
            <Card className="grid min-h-64 place-items-center border-dashed text-center">
              <div>
                <GitFork className="mx-auto h-8 w-8 text-slate-600" />
                <p className="mt-3 font-medium text-white">No repositories yet</p>
                <p className="mt-1 text-sm text-slate-500">Clone a public URL or upload a ZIP to begin.</p>
              </div>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {repositories.data?.items.map((repository) => (
                <Card className="group relative overflow-hidden" key={repository.id}>
                  <div className="absolute inset-x-0 top-0 h-0.5 bg-slate-800">
                    <div className="h-full bg-cyan-400 transition-all" style={{ width: `${repository.progress * 100}%` }} />
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link className="focus-ring truncate text-lg font-semibold text-white hover:text-cyan-300" href={`/repositories/${repository.id}`}>
                        {repository.name}
                      </Link>
                      <p className="mt-1 truncate font-mono text-xs text-slate-500">{repository.defaultRef ?? repository.sourceType}</p>
                    </div>
                    <Badge tone={stateTone(repository.state)}>{repository.state.replace('_', ' ')}</Badge>
                  </div>
                  <div className="mt-6 grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-lg bg-slate-950/70 p-3">
                      <p className="text-slate-500">Commits</p>
                      <p className="mt-1 font-mono text-white">{repository.commitCount.toLocaleString()}</p>
                    </div>
                    <div className="rounded-lg bg-slate-950/70 p-3">
                      <p className="text-slate-500">Updated</p>
                      <p className="mt-1 text-white">{new Date(repository.updatedAt).toLocaleDateString()}</p>
                    </div>
                  </div>
                  <p className="mt-4 flex min-h-5 items-center gap-2 text-xs text-slate-500">
                    {repository.state !== 'ready' ? <Clock3 className="h-3.5 w-3.5" /> : <Activity className="h-3.5 w-3.5" />}
                    {repository.lastError ?? repository.progressStage ?? 'Ready to explore'}
                  </p>
                  <div className="mt-4 flex justify-end gap-2 border-t border-slate-800 pt-4">
                    <button className="focus-ring rounded-lg p-2 text-slate-500 hover:bg-slate-800 hover:text-cyan-300" disabled={refresh.isPending} onClick={() => refresh.mutate(repository.id)} title="Refresh" type="button">
                      <RefreshCw className="h-4 w-4" />
                    </button>
                    <button className="focus-ring rounded-lg p-2 text-slate-500 hover:bg-rose-950 hover:text-rose-300" disabled={remove.isPending} onClick={() => window.confirm(`Delete ${repository.name}?`) && remove.mutate(repository.id)} title="Delete" type="button">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
