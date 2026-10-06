'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Scale } from 'lucide-react';
import { Card, ErrorNotice, Loading, MetricCard, formatCount } from '@rat/ui';
import { getMetrics, listRepositories } from '../../lib/api';

export default function ComparePage() {
  const repositories = useQuery({ queryKey: ['repositories'], queryFn: listRepositories });
  const ready = useMemo(() => repositories.data?.items.filter((item) => item.state === 'ready' && item.activeAnalysisId) ?? [], [repositories.data]);
  const [selected, setSelected] = useState<string[]>([]);
  const selectedRepositories = ready.filter((repository) => selected.includes(repository.id));
  const metrics = useQueries({
    queries: selectedRepositories.map((repository) => ({
      queryKey: ['compare', repository.activeAnalysisId],
      queryFn: () => getMetrics({ analysisId: repository.activeAnalysisId!, commits: { mode: 'all' }, groupBy: 'none', limit: 10 }),
    })),
  });

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <Link className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-white" href="/"><ArrowLeft className="h-4 w-4" /> Repositories</Link>
      <div className="mt-4 flex items-center gap-4"><span className="grid h-12 w-12 place-items-center rounded-xl bg-indigo-400/10 text-indigo-300"><Scale className="h-6 w-6" /></span><div><h1 className="text-3xl font-semibold text-white">Compare repositories</h1><p className="mt-1 text-slate-400">Use per-commit rates to compare repositories of different sizes.</p></div></div>
      <Card className="mt-8">
        <p className="text-sm font-medium text-white">Select two to four ready repositories</p>
        {repositories.isLoading ? <Loading /> : <div className="mt-4 grid gap-2 sm:grid-cols-2">{ready.map((repository) => <label className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3" key={repository.id}><input checked={selected.includes(repository.id)} disabled={!selected.includes(repository.id) && selected.length >= 4} onChange={() => setSelected((current) => current.includes(repository.id) ? current.filter((id) => id !== repository.id) : [...current, repository.id])} type="checkbox" /><span><span className="block text-white">{repository.name}</span><span className="text-xs text-slate-500">{repository.commitCount.toLocaleString()} commits</span></span></label>)}</div>}
        {ready.length < 2 ? <p className="mt-4 text-sm text-amber-300">Analyze at least two repositories before using comparison.</p> : null}
      </Card>
      <section className="mt-6 grid gap-5 md:grid-cols-2">
        {selectedRepositories.map((repository, index) => {
          const result = metrics[index];
          if (result?.isLoading) return <Card key={repository.id}><Loading /></Card>;
          if (result?.error) return <ErrorNotice key={repository.id} message={result.error.message} />;
          const summary = result?.data?.summary;
          return <Card key={repository.id}><h2 className="text-lg font-semibold text-white">{repository.name}</h2><p className="mt-1 font-mono text-xs text-slate-500">{repository.defaultRef}</p>{summary ? <div className="mt-5 grid grid-cols-2 gap-3"><MetricCard label="Churn" value={formatCount(summary.churn)} /><MetricCard label="Churn / commit" value={summary.churnRate.toFixed(2)} /><MetricCard label="Growth" value={formatCount(summary.growth)} /><MetricCard label="Modification frequency" value={`${(summary.modificationFrequency * 100).toFixed(1)}%`} /></div> : null}</Card>;
        })}
      </section>
    </main>
  );
}
