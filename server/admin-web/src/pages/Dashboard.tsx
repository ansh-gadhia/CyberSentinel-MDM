import { useQuery } from '@tanstack/react-query';
import { listDevices } from '../api/devices';
import { useEventStream } from '../hooks/useWebSocket';
import { useState } from 'react';

export function Dashboard() {
  const [events, setEvents] = useState<string[]>([]);
  useEventStream(e => setEvents(prev => [`${new Date().toLocaleTimeString()} ${e.subject}`, ...prev].slice(0, 50)));

  const { data } = useQuery({
    queryKey: ['devices', 'summary'],
    queryFn: () => listDevices({ limit: 1 })
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Overview</h1>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Stat label="Total devices" value={data?.total ?? '…'} />
        <Stat label="Enrolled (live)" value={data?.items?.filter(d => d.state === 'enrolled').length ?? '…'} />
        <Stat label="Offline" value="—" />
        <Stat label="Pending" value="—" />
      </div>

      <div className="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 p-4">
        <h2 className="font-medium mb-2">Live event stream</h2>
        <ul className="text-sm font-mono text-slate-600 dark:text-slate-300 space-y-1 max-h-72 overflow-auto">
          {events.length === 0 && <li className="text-slate-400">listening…</li>}
          {events.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div className="text-xs uppercase text-slate-500">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  );
}
