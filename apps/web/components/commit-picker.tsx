'use client';

import { useMemo } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type { CommitItem } from '../lib/api';

const columns = createColumnHelper<CommitItem>();

export function CommitPicker({
  commits,
  selected,
  onToggle,
}: {
  commits: CommitItem[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const tableColumns = useMemo(
    () => [
      columns.display({
        id: 'select',
        header: 'Use',
        cell: ({ row }) => (
          <input
            aria-label={`Select commit ${row.original.oid.slice(0, 8)}`}
            checked={selected.has(row.original.id)}
            onChange={() => onToggle(row.original.id)}
            type="checkbox"
          />
        ),
      }),
      columns.accessor('oid', {
        header: 'Commit',
        cell: ({ getValue }) => <code className="text-cyan-300">{getValue().slice(0, 8)}</code>,
      }),
      columns.accessor('subject', { header: 'Subject' }),
      columns.accessor('authorName', { header: 'Author' }),
      columns.accessor('committerAt', {
        header: 'Committed',
        cell: ({ getValue }) => new Date(getValue()).toLocaleString(),
      }),
    ],
    [onToggle, selected],
  );
  const table = useReactTable({ data: commits, columns: tableColumns, getCoreRowModel: getCoreRowModel() });

  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-slate-800">
      <table className="w-full min-w-[680px] text-left text-sm">
        <thead className="sticky top-0 bg-slate-950 text-xs uppercase tracking-wide text-slate-500">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <th className="px-3 py-2" key={header.id}>
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody className="divide-y divide-slate-800">
          {table.getRowModel().rows.map((row) => (
            <tr className="hover:bg-slate-800/50" key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td className="max-w-xs truncate px-3 py-2 text-slate-300" key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
