import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useMemo, useState } from 'react';
import { formatRelative } from '../components/online';
import { listUsers } from '../api/auth';
import { listDevices, deviceLabel } from '../api/devices';

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

  // Resolve actor UUIDs → emails and target device UUIDs → friendly labels.
  // listUsers is admin-only; if the caller can't read it (viewer/operator) we
  // fall back to showing the raw UUID rather than failing the whole page.
  const { data: users } = useQuery({
    queryKey: ['tenant-users'], queryFn: listUsers, retry: false,
    staleTime: 60_000
  });
  const { data: devices } = useQuery({
    queryKey: ['devices', 'audit-lookup'],
    queryFn: () => listDevices({ limit: 500 }),
    staleTime: 30_000
  });

  const userEmail = useMemo(() => {
    const m = new Map<string, string>();
    (users ?? []).forEach(u => m.set(u.id, u.email));
    return m;
  }, [users]);
  const deviceName = useMemo(() => {
    const m = new Map<string, string>();
    (devices?.items ?? []).forEach(d => m.set(d.id, deviceLabel(d)));
    return m;
  }, [devices]);

  const actorLabel = (e: Entry): string => {
    if (e.actor_kind === 'user') {
      if (e.actor_id && userEmail.has(e.actor_id)) return userEmail.get(e.actor_id)!;
      return e.actor_id ? `user ${e.actor_id.slice(0, 8)}…` : 'unknown user';
    }
    if (e.actor_kind === 'device') {
      if (e.actor_id && deviceName.has(e.actor_id)) return deviceName.get(e.actor_id)!;
      return e.actor_id ? `device ${e.actor_id.slice(0, 8)}…` : 'device';
    }
    return 'system';
  };

  const targetLabel = (e: Entry): string | null => {
    // Device targets: prefer target_id, fall back to metadata.device_id (some
    // command events carry it there). Resolve to the device's name; if it's no
    // longer in the fleet (retired/deleted) say so instead of a bare id.
    if (e.target_kind === 'device') {
      const id = e.target_id ?? (e.metadata?.device_id as string | undefined);
      if (id) return deviceName.get(id) ?? `device ${id.slice(0, 8)}… (removed)`;
    }
    if (!e.target_id) return e.target_kind ?? null;
    return `${e.target_kind ?? 'target'} ${e.target_id.slice(0, 8)}…`;
  };

  const filtered = data?.filter(e => {
    if (!filter) return true;
    const f = filter.toLowerCase();
    return e.action.toLowerCase().includes(f)
      || e.actor_kind.toLowerCase().includes(f)
      || actorLabel(e).toLowerCase().includes(f)
      || (targetLabel(e) ?? '').toLowerCase().includes(f);
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <input value={filter} onChange={e => setFilter(e.target.value)}
               placeholder="filter by action, account or device…"
               className="rounded border px-3 py-1.5 bg-transparent text-sm w-80" />
      </div>
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800 text-left text-slate-500">
            <tr>
              <th className="px-4 py-2 font-normal">When</th>
              <th className="px-4 py-2 font-normal">Account / Actor</th>
              <th className="px-4 py-2 font-normal">Action</th>
              <th className="px-4 py-2 font-normal">Device / Target</th>
              <th className="px-4 py-2 font-normal">Detail</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-400">loading…</td></tr>}
            {!isLoading && filtered?.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">No audit events match.</td></tr>
            )}
            {filtered?.map(e => {
              const tgt = targetLabel(e);
              return (
                <tr key={e.id} className="border-t border-slate-100 dark:border-slate-800 align-top">
                  <td className="px-4 py-2 text-xs text-slate-500 whitespace-nowrap" title={e.created_at}>{formatRelative(e.created_at)}</td>
                  <td className="px-4 py-2 text-xs">
                    <div className="flex items-center gap-1.5">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] ${e.actor_kind === 'user' ? 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300' : e.actor_kind === 'device' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-slate-100 text-slate-600'}`}>
                        {e.actor_kind}
                      </span>
                      <span className="font-medium" title={e.actor_id ?? ''}>{actorLabel(e)}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{e.action}</td>
                  <td className="px-4 py-2 text-xs" title={e.target_id ?? ''}>
                    {tgt ? <span>{tgt}</span> : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">
                    {e.metadata && Object.keys(e.metadata).length > 0 && (
                      <code className="text-[11px]">{JSON.stringify(e.metadata)}</code>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
