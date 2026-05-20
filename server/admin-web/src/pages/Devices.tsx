import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listDevices } from '../api/devices';
import { useState } from 'react';
import { formatRelative, isOnline } from '../components/online';

export function Devices() {
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['devices', q, state],
    queryFn: () => listDevices({ q, state, limit: 100 }),
    refetchInterval: 5000
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Devices</h1>
        <div className="flex gap-2">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="search serial/model/imei…"
                 className="rounded border px-3 py-2 bg-transparent text-sm" />
          <select value={state} onChange={e => setState(e.target.value)}
                  className="rounded border px-3 py-2 bg-transparent text-sm">
            <option value="">all states</option>
            {['pending', 'enrolled', 'offline', 'wiped', 'retired'].map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800 text-left text-slate-500">
            <tr>
              <th className="px-4 py-2 font-normal">Connection</th>
              <th className="px-4 py-2 font-normal">Serial</th>
              <th className="px-4 py-2 font-normal">Model</th>
              <th className="px-4 py-2 font-normal">OS</th>
              <th className="px-4 py-2 font-normal">State</th>
              <th className="px-4 py-2 font-normal">Policy</th>
              <th className="px-4 py-2 font-normal">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={7} className="px-4 py-6 text-center text-slate-400">loading…</td></tr>}
            {!isLoading && data?.items?.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">No devices enrolled yet. Generate a token on the Enrollment page.</td></tr>
            )}
            {data?.items.map(d => {
              const online = isOnline(d.last_heartbeat_at);
              return (
                <tr key={d.id} className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="px-4 py-2">
                    <span title={online ? 'Heartbeat within the last 2.5 min' : 'No recent heartbeat'}
                          className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${online
                            ? 'text-emerald-700 dark:text-emerald-300'
                            : 'text-slate-500'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${online ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
                      {online ? 'Connected' : 'Offline'}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono">
                    <Link to={`/devices/${d.id}`} className="text-brand-600 hover:underline">
                      {d.serial_number ?? d.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-4 py-2">{d.manufacturer ?? ''} {d.model ?? ''}</td>
                  <td className="px-4 py-2">{d.os_version ?? '—'}</td>
                  <td className="px-4 py-2"><StateBadge state={d.state} /></td>
                  <td className="px-4 py-2 text-xs text-slate-500">v{d.applied_policy_version}</td>
                  <td className="px-4 py-2 text-xs text-slate-500" title={d.last_heartbeat_at}>{formatRelative(d.last_heartbeat_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const map: Record<string, string> = {
    enrolled: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
    offline:  'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    pending:  'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    wiped:    'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
    retired:  'bg-slate-100 text-slate-500'
  };
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] uppercase tracking-wide ${map[state] ?? ''}`}>{state}</span>;
}
