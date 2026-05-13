import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listDevices } from '../api/devices';
import { useState } from 'react';

export function Devices() {
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['devices', q, state],
    queryFn: () => listDevices({ q, state, limit: 100 })
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Devices</h1>
        <div className="flex gap-2">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="search serial/model/imei…"
                 className="rounded border px-3 py-2 bg-transparent text-sm" />
          <select value={state} onChange={e => setState(e.target.value)}
                  className="rounded border px-3 py-2 bg-transparent text-sm">
            <option value="">all states</option>
            {['pending','enrolled','offline','wiped','retired'].map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800 text-left">
            <tr>
              <th className="px-4 py-2">Serial</th>
              <th className="px-4 py-2">Model</th>
              <th className="px-4 py-2">OS</th>
              <th className="px-4 py-2">State</th>
              <th className="px-4 py-2">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-500">loading…</td></tr>}
            {data?.items.map(d => (
              <tr key={d.id} className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40">
                <td className="px-4 py-2 font-mono"><Link to={`/devices/${d.id}`} className="text-brand-600">{d.serial_number ?? d.id.slice(0,8)}</Link></td>
                <td className="px-4 py-2">{d.manufacturer ?? ''} {d.model ?? ''}</td>
                <td className="px-4 py-2">{d.os_version ?? '—'}</td>
                <td className="px-4 py-2"><Badge state={d.state} /></td>
                <td className="px-4 py-2">{d.last_heartbeat_at ? new Date(d.last_heartbeat_at).toLocaleString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Badge({ state }: { state: string }) {
  const map: Record<string, string> = {
    enrolled: 'bg-emerald-100 text-emerald-700',
    offline:  'bg-amber-100 text-amber-700',
    pending:  'bg-slate-100 text-slate-700',
    wiped:    'bg-rose-100 text-rose-700',
    retired:  'bg-slate-100 text-slate-500'
  };
  return <span className={`inline-block px-2 py-0.5 rounded text-xs ${map[state] ?? ''}`}>{state}</span>;
}
