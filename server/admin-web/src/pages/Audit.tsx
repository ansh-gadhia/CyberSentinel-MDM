import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

interface Entry {
  id: string;
  actor_kind: string;
  action: string;
  target_kind?: string;
  target_id?: string;
  created_at: string;
}

export function Audit() {
  const { data, isLoading } = useQuery({
    queryKey: ['audit'],
    queryFn: async () => (await api.get<{ items: Entry[] }>('/api/v1/audit?limit=200')).data.items
  });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Audit Log</h1>
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800 text-left">
            <tr><th className="px-4 py-2">When</th><th className="px-4 py-2">Actor</th><th className="px-4 py-2">Action</th><th className="px-4 py-2">Target</th></tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-500">loading…</td></tr>}
            {data?.map(e => (
              <tr key={e.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2 whitespace-nowrap">{new Date(e.created_at).toLocaleString()}</td>
                <td className="px-4 py-2">{e.actor_kind}</td>
                <td className="px-4 py-2 font-mono text-xs">{e.action}</td>
                <td className="px-4 py-2">{e.target_kind ?? ''} {e.target_id?.slice(0,8) ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
