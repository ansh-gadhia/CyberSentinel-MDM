import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listDevices } from '../api/devices';
import { listPolicies } from '../api/policies';
import { useEventStream } from '../hooks/useWebSocket';
import { useState } from 'react';
import { isOnline, formatRelative } from '../components/online';
import { api } from '../api/client';
import { DeviceMap } from '../components/DeviceMap';

interface AuditRow { id: string; actor_kind: string; action: string; target_id?: string; created_at: string }

export function Dashboard() {
  const [events, setEvents] = useState<string[]>([]);
  useEventStream(e => setEvents(prev => [`${new Date().toLocaleTimeString()} ${e.subject}`, ...prev].slice(0, 50)));

  const { data: devices } = useQuery({
    queryKey: ['devices', 'all'],
    queryFn: () => listDevices({ limit: 500 }),
    refetchInterval: 10000
  });
  const { data: policies } = useQuery({ queryKey: ['policies'], queryFn: listPolicies });
  const { data: audit } = useQuery({
    queryKey: ['audit', 'recent'],
    queryFn: async () => (await api.get<{ items: AuditRow[] }>('/api/v1/audit?limit=10')).data.items,
    refetchInterval: 5000
  });

  const items = devices?.items ?? [];
  const online = items.filter(d => isOnline(d.last_heartbeat_at)).length;
  const enrolled = items.filter(d => d.state === 'enrolled').length;
  const pending = items.filter(d => d.state === 'pending').length;
  const retired = items.filter(d => d.state === 'retired').length;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Overview</h1>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Stat label="Total devices" value={devices?.total ?? '—'} sub={<Link to="/devices" className="text-brand-600 hover:underline">view all →</Link>} />
        <Stat label="Online now" value={online} tone="emerald" />
        <Stat label="Enrolled" value={enrolled} />
        <Stat label="Pending" value={pending} tone="amber" />
        <Stat label="Policies" value={policies?.length ?? 0} sub={<Link to="/policies" className="text-brand-600 hover:underline">manage →</Link>} />
      </div>

      <DeviceMap devices={items} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <h2 className="font-medium mb-3">Recent audit events</h2>
          {(!audit || audit.length === 0) ? (
            <p className="text-sm text-slate-500">No audit events yet. They will appear here as you operate devices.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {audit.slice(0, 10).map(e => (
                <li key={e.id} className="flex items-baseline gap-2 border-b border-slate-100 dark:border-slate-800 py-1">
                  <span className="text-xs text-slate-500 w-20 shrink-0">{formatRelative(e.created_at)}</span>
                  <code className="text-xs">{e.action}</code>
                  <span className="text-xs text-slate-500">{e.actor_kind}</span>
                </li>
              ))}
            </ul>
          )}
          <Link to="/audit" className="text-xs text-brand-600 hover:underline mt-3 inline-block">view full audit log →</Link>
        </section>

        <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <h2 className="font-medium mb-3">Live event stream</h2>
          {events.length === 0 ? (
            <p className="text-sm text-slate-500">Listening for events on /ws… nothing yet.</p>
          ) : (
            <ul className="text-xs font-mono text-slate-600 dark:text-slate-300 space-y-1 max-h-72 overflow-auto">
              {events.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
        </section>
      </div>

      {retired > 0 && (
        <p className="text-xs text-slate-400">{retired} retired device{retired === 1 ? '' : 's'} not shown above.</p>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'emerald' | 'amber' }) {
  const ring = tone === 'emerald' ? 'ring-emerald-500/30' : tone === 'amber' ? 'ring-amber-500/30' : 'ring-slate-300/30';
  return (
    <div className={`rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 ring-1 ${ring}`}>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {sub && <div className="text-xs mt-1">{sub}</div>}
    </div>
  );
}
