import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useState } from 'react';
import { formatRelative } from '../components/online';

interface Entry {
  id: string;
  actor_kind: string;
  actor_id?: string;
  action: string;
  target_kind?: string;
  target_id?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export function Audit() {
  const [filter, setFilter] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['audit'],
    queryFn: async () => (await api.get<{ items: Entry[] }>('/api/v1/audit?limit=300')).data.items,
    refetchInterval: 5000
  });

  const filtered = data?.filter(e =>
    !filter ||
    e.action.toLowerCase().includes(filter.toLowerCase()) ||
    e.actor_kind.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <input value={filter} onChange={e => setFilter(e.target.value)}
               placeholder="filter by action or actor…"
               className="rounded border px-3 py-1.5 bg-transparent text-sm w-72" />
      </div>
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800 text-left text-slate-500">
            <tr>
              <th className="px-4 py-2 font-normal">When</th>
              <th className="px-4 py-2 font-normal">Actor</th>
              <th className="px-4 py-2 font-normal">Action</th>
              <th className="px-4 py-2 font-normal">Target</th>
              <th className="px-4 py-2 font-normal">Detail</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-400">loading…</td></tr>}
            {!isLoading && filtered?.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">No audit events match.</td></tr>
            )}
            {filtered?.map(e => (
              <tr key={e.id} className="border-t border-slate-100 dark:border-slate-800 align-top">
                <td className="px-4 py-2 text-xs text-slate-500 whitespace-nowrap" title={e.created_at}>{formatRelative(e.created_at)}</td>
                <td className="px-4 py-2 text-xs">
                  <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] ${e.actor_kind === 'user' ? 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300' : e.actor_kind === 'device' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-slate-100 text-slate-600'}`}>
                    {e.actor_kind}
                  </span>
                </td>
                <td className="px-4 py-2 font-mono text-xs">{e.action}</td>
                <td className="px-4 py-2 text-xs text-slate-500">
                  {e.target_kind && <span>{e.target_kind}</span>}
                  {e.target_id && <span className="font-mono ml-1">{e.target_id.slice(0, 8)}…</span>}
                </td>
                <td className="px-4 py-2 text-xs text-slate-500">
                  {e.metadata && Object.keys(e.metadata).length > 0 && (
                    <code className="text-[11px]">{JSON.stringify(e.metadata)}</code>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
