'use client';

import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { AlertTriangle, LoaderCircle } from 'lucide-react';
import clsx from 'clsx';

export function Button({ className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={clsx(
        'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <section
      className={clsx('rounded-2xl border border-slate-800 bg-slate-900/75 p-5 shadow-xl shadow-black/10', className)}
      {...props}
    />
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' }) {
  const colors = {
    neutral: 'border-slate-700 bg-slate-800 text-slate-300',
    good: 'border-emerald-700/60 bg-emerald-950 text-emerald-300',
    warn: 'border-amber-700/60 bg-amber-950 text-amber-300',
    bad: 'border-rose-700/60 bg-rose-950 text-rose-300',
  };
  return <span className={clsx('rounded-full border px-2.5 py-1 text-xs font-medium', colors[tone])}>{children}</span>;
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex min-h-48 items-center justify-center gap-3 text-slate-400" role="status">
      <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-rose-800 bg-rose-950/60 p-4 text-rose-200" role="alert">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-semibold">Something went wrong</p>
          <p className="mt-1 text-sm text-rose-300">{message}</p>
          {onRetry ? (
            <button className="mt-3 text-sm font-semibold underline" onClick={onRetry} type="button">
              Try again
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function MetricCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <Card className="min-w-0">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-3 truncate font-mono text-2xl font-semibold text-white" title={value}>
        {value}
      </p>
      {detail ? <p className="mt-1 text-xs text-slate-500">{detail}</p> : null}
    </Card>
  );
}

export function formatCount(value: string | number): string {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(numeric) : String(value);
}

export function formatPercent(value: number): string {
  return Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(value);
}
