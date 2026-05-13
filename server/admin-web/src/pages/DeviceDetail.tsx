import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deviceTelemetryLatest, getDevice, issueCommand, listDeviceCommands, retireDevice } from '../api/devices';
import type { CommandRow } from '../api/devices';

const COMMANDS = [
  'LOCK', 'WIPE', 'REBOOT', 'RESET_PASSWORD',
  'FETCH_DEVICE_INFO', 'FETCH_APP_INVENTORY', 'COLLECT_LOGS', 'APPLY_POLICY'
];

export function DeviceDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { data: device } = useQuery({ queryKey: ['device', id], queryFn: () => getDevice(id) });
  const { data: commands } = useQuery({ queryKey: ['commands', id], queryFn: () => listDeviceCommands(id), refetchInterval: 5000 });
  const { data: telemetry } = useQuery({ queryKey: ['telemetry', id], queryFn: () => deviceTelemetryLatest(id) });
  const cmd = useMutation({
    mutationFn: (kind: string) => issueCommand(id, kind),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['commands', id] })
  });
  const retire = useMutation({ mutationFn: () => retireDevice(id) });

  if (!device) return <div>Loading…</div>;

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{device.manufacturer} {device.model}</h1>
          <p className="text-sm text-slate-500 font-mono">{device.serial_number ?? device.id}</p>
        </div>
        <button
          onClick={() => { if (confirm('Retire this device?')) retire.mutate(); }}
          className="text-sm px-3 py-1.5 rounded border border-rose-300 text-rose-600 hover:bg-rose-50"
        >Retire</button>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card title="State"><Badge state={device.state} /></Card>
        <Card title="OS">{device.os_version} (patch {device.security_patch_level ?? '?'})</Card>
        <Card title="Applied Policy Version">{device.applied_policy_version}</Card>
      </section>

      <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
        <h2 className="font-medium mb-3">Remote commands</h2>
        <div className="flex flex-wrap gap-2">
          {COMMANDS.map(k => (
            <button key={k} onClick={() => cmd.mutate(k)}
                    className="text-sm px-3 py-1.5 rounded border hover:bg-brand-50">
              {k}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
        <h2 className="font-medium mb-3">Command history</h2>
        <table className="w-full text-sm">
          <thead className="text-left">
            <tr><th>Kind</th><th>State</th><th>Attempts</th><th>Created</th><th></th></tr>
          </thead>
          <tbody>
            {commands?.map(c => <CommandHistoryRow key={c.id} c={c} />)}
          </tbody>
        </table>
      </section>

      <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
        <h2 className="font-medium mb-3">Latest telemetry</h2>
        <pre className="text-xs bg-slate-50 dark:bg-slate-950 rounded p-3 overflow-auto">{JSON.stringify(telemetry, null, 2)}</pre>
      </section>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div className="text-xs uppercase text-slate-500">{title}</div>
      <div className="text-lg mt-1">{children}</div>
    </div>
  );
}
function Badge({ state }: { state: string }) {
  const tone =
    state === 'succeeded' ? 'bg-emerald-100 text-emerald-700' :
    state === 'failed'    ? 'bg-rose-100 text-rose-700' :
    state === 'timed_out' ? 'bg-amber-100 text-amber-700' :
    state === 'dispatched'? 'bg-sky-100 text-sky-700' :
                            'bg-slate-200 text-slate-700';
  return <span className={`inline-block px-2 py-0.5 rounded text-xs ${tone}`}>{state}</span>;
}

function CommandHistoryRow({ c }: { c: CommandRow }) {
  const [open, setOpen] = useState(false);
  const expandable = c.result != null || (c.last_error && c.last_error.length > 0);
  return (
    <>
      <tr className="border-t border-slate-100 dark:border-slate-800">
        <td className="py-1 font-mono text-xs">{c.kind}</td>
        <td className="py-1"><Badge state={c.state} /></td>
        <td className="py-1">{c.attempts}</td>
        <td className="py-1">{new Date(c.created_at).toLocaleTimeString()}</td>
        <td className="py-1 text-right">
          {expandable && (
            <button onClick={() => setOpen(v => !v)}
                    className="text-xs px-2 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800">
              {open ? 'Hide' : 'View'}
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="bg-slate-50 dark:bg-slate-950">
          <td colSpan={5} className="px-3 pb-3">
            {c.last_error && (
              <div className="mb-2 text-xs text-rose-600">Error: {c.last_error}</div>
            )}
            {c.result != null && (
              <pre className="text-xs bg-white dark:bg-slate-900 rounded border border-slate-200 dark:border-slate-800 p-3 overflow-auto max-h-96">
                {JSON.stringify(c.result, null, 2)}
              </pre>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
