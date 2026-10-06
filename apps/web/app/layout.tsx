import type { Metadata } from 'next';
import Link from 'next/link';
import { BarChart3, GitBranch } from 'lucide-react';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'RAT · Repository Intelligence',
  description: 'Explore repository churn, growth, ownership, and change hotspots.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <header className="sticky top-0 z-40 border-b border-slate-800/90 bg-slate-950/85 backdrop-blur-xl">
            <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between px-4 sm:px-6 lg:px-8">
              <Link className="focus-ring flex items-center gap-3 rounded-lg" href="/">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-cyan-400 text-slate-950">
                  <GitBranch className="h-5 w-5" aria-hidden="true" />
                </span>
                <span>
                  <span className="block text-sm font-bold tracking-wide text-white">RAT</span>
                  <span className="block text-[10px] uppercase tracking-[0.2em] text-slate-500">Repository intelligence</span>
                </span>
              </Link>
              <nav className="flex items-center gap-2 text-sm" aria-label="Primary navigation">
                <Link className="focus-ring rounded-lg px-3 py-2 text-slate-300 hover:bg-slate-800 hover:text-white" href="/">
                  Repositories
                </Link>
                <Link className="focus-ring flex items-center gap-2 rounded-lg px-3 py-2 text-slate-300 hover:bg-slate-800 hover:text-white" href="/compare">
                  <BarChart3 className="h-4 w-4" aria-hidden="true" /> Compare
                </Link>
              </nav>
            </div>
          </header>
          {children}
        </Providers>
      </body>
    </html>
  );
}
