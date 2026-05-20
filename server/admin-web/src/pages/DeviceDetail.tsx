import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deviceTelemetryLatest, getDevice, issueCommand,
  latestResultByKind, listDeviceCommands, listDeviceEvents, retireDevice,
  type ActivityEvent, type CommandRow, type Device
} from '../api/devices';
import {
  assignPolicy, listAssignmentsForDevice, listPolicies, resolvedPolicyForDevice,
  unassignPolicy, type PolicyAssignment
} from '../api/policies';
import { listDevicePhotos, presignPhoto, deletePhoto } from '../api/photos';
import { formatRelative, isOnline } from '../components/online';
import { toast } from '../components/toast';

type TabId = 'overview' | 'policy' | 'apps' | 'photos' | 'activity' | 'commands';

export function DeviceDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabId>('overview');

  const { data: device } = useQuery({
    queryKey: ['device', id], queryFn: () => getDevice(id), refetchInterval: 5000
  });
  const { data: commands } = useQuery({
    queryKey: ['commands', id], queryFn: () => listDeviceCommands(id), refetchInterval: 3000
  });
  const { data: telemetry } = useQuery({
    queryKey: ['telemetry', id], queryFn: () => deviceTelemetryLatest(id).catch(() => null),
    refetchInterval: 15000
  });

  const cmd = useMutation({
    mutationFn: ({ kind, payload }: { kind: string; payload?: Record<string, unknown> }) =>
      issueCommand(id, kind, payload),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: ['commands', id] });
      toast.info(`${vars.kind} queued`);
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || `Failed to queue command`)
  });
  const retire = useMutation({
    mutationFn: () => retireDevice(id),
    onSuccess: () => toast.success('Device retired'),
    onError:   () => toast.error('Retire failed')
  });

  // Auto-fetch device info on first load if missing
  const deviceInfo  = latestResultByKind(commands, 'FETCH_DEVICE_INFO');
  const appInventory = latestResultByKind(commands, 'FETCH_APP_INVENTORY');
  useEffect(() => {
    if (!commands || !device || deviceInfo) return;
    const recent = commands.find(c =>
      c.kind === 'FETCH_DEVICE_INFO' &&
      Date.now() - new Date(c.created_at).getTime() < 60_000
    );
    if (!recent) cmd.mutate({ kind: 'FETCH_DEVICE_INFO' });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commands?.length, device?.id]);

  const online = isOnline(device?.last_heartbeat_at);

  if (!device) return <Skeleton />;

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs text-slate-500"><Link to="/devices" className="hover:underline">Devices</Link> /</div>
          <div className="flex items-center gap-2 mt-0.5">
            <h1 className="text-2xl font-semibold truncate">
              {device.manufacturer || 'Device'} {device.model || ''}
            </h1>
            <ConnectionPill online={online} lastHeartbeat={device.last_heartbeat_at} />
            <StateBadge state={device.state} />
          </div>
          <div className="text-sm text-slate-500 font-mono mt-1">{device.serial_number ?? device.id}</div>
        </div>
        <button
          onClick={() => { if (confirm('Retire this device? It will no longer be managed.')) retire.mutate(); }}
          className="text-sm px-3 py-1.5 rounded border border-rose-300 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950">
          Retire
        </button>
      </header>

      <Tabs current={tab} onSelect={setTab} commands={commands} />

      {tab === 'overview' && <OverviewTab device={device} info={deviceInfo} cmd={cmd} telemetry={telemetry ?? null} />}
      {tab === 'policy'   && <PolicyTab   deviceID={id} cmd={cmd} />}
      {tab === 'apps'     && <AppsTab    deviceID={id} inventory={appInventory} cmd={cmd} />}
      {tab === 'photos'   && <PhotosTab  deviceID={id} cmd={cmd} />}
      {tab === 'activity' && <ActivityTab deviceID={id} />}
      {tab === 'commands' && <CommandsTab commands={commands} />}
    </div>
  );
}

function Tabs({ current, onSelect, commands }: {
  current: TabId;
  onSelect: (t: TabId) => void;
  commands: CommandRow[] | undefined;
}) {
  const pendingCount = (commands || []).filter(c =>
    c.state === 'pending' || c.state === 'dispatched' || c.state === 'acknowledged'
  ).length;
  const tabs: Array<{ id: TabId; label: string; hint?: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'policy',   label: 'Policy' },
    { id: 'apps',     label: 'Apps' },
    { id: 'photos',   label: 'Photos & Location' },
    { id: 'activity', label: 'Activity' },
    { id: 'commands', label: 'Commands', hint: pendingCount > 0 ? `${pendingCount} pending` : undefined }
  ];
  return (
    <div className="border-b border-slate-200 dark:border-slate-800 -mx-6 px-6 sticky top-0 z-10 bg-white dark:bg-slate-950">
      <nav className="flex gap-1">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            className={`relative px-4 py-2.5 text-sm transition-colors ${
              current === t.id
                ? 'text-brand-600 font-medium'
                : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
            }`}>
            {t.label}
            {t.hint && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300">{t.hint}</span>}
            {current === t.id && (
              <span className="absolute bottom-[-1px] left-2 right-2 h-0.5 bg-brand-600 rounded-full" />
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}

/* ============================== Overview Tab ============================== */

function OverviewTab({
  device, info, telemetry, cmd
}: {
  device: Device;
  info: Record<string, unknown> | null;
  telemetry: Record<string, unknown> | null;
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
}) {
  return (
    <div className="space-y-5">
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="OS" value={device.os_version ?? '—'} hint={device.security_patch_level ? `patch ${device.security_patch_level}` : undefined} />
        <Stat label="Applied policy" value={`v${device.applied_policy_version}`} />
        <Stat label="Battery" value={info ? `${info.battery_pct}%` : '—'} hint={info?.charging ? 'charging' : undefined} />
        <Stat label="Network" value={(info?.network as string) ?? '—'} />
      </section>

      <PolicyCard deviceID={device.id} cmd={cmd} />

      {/* Remote actions */}
      <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
        <h2 className="font-medium mb-3">Remote actions</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <ActionGroup title="Maintenance">
            <ActionBtn label="Lock screen" onClick={() => cmd.mutate({ kind: 'LOCK' })} />
            <ActionBtn label="Reboot"      onClick={() => cmd.mutate({ kind: 'REBOOT' })} />
          </ActionGroup>
          <ActionGroup title="Security">
            <ResetPasswordBtn onSubmit={(pw) => cmd.mutate({ kind: 'RESET_PASSWORD', payload: { password: pw } })} />
            <WipeBtn onConfirm={() => cmd.mutate({ kind: 'WIPE', payload: { external_storage: true, reset_protection: true } })} />
          </ActionGroup>
          <ActionGroup title="Asset recovery">
            <FlashlightToggle cmd={cmd} />
            <ActionBtn label="Play alarm sound" onClick={() => cmd.mutate({ kind: 'PLAY_SOUND', payload: { duration_ms: 15000 } })} />
            <ActionBtn label="Get location" onClick={() => cmd.mutate({ kind: 'GET_LOCATION' })} />
          </ActionGroup>
          <ActionGroup title="Inventory">
            <ActionBtn label="Refresh device info"   onClick={() => cmd.mutate({ kind: 'FETCH_DEVICE_INFO' })} />
            <ActionBtn label="Refresh app inventory" onClick={() => cmd.mutate({ kind: 'FETCH_APP_INVENTORY' })} />
          </ActionGroup>
        </div>
      </section>

      <LiveLocationCard device={device} />

      <DeviceInfoCard info={info} />

      {telemetry && Object.keys(telemetry).length > 0 && (
        <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <h2 className="font-medium mb-3">Latest telemetry</h2>
          <pre className="text-xs bg-slate-50 dark:bg-slate-950 rounded p-3 overflow-auto max-h-64">{JSON.stringify(telemetry, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}

function PolicyCard({ deviceID, cmd }: {
  deviceID: string;
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
}) {
  const qc = useQueryClient();
  const { data: policies } = useQuery({ queryKey: ['policies'], queryFn: listPolicies });
  const { data: assignedPolicy, refetch } = useQuery({
    queryKey: ['assignedPolicy', deviceID],
    queryFn: () => resolvedPolicyForDevice(deviceID)
  });
  const [pick, setPick] = useState('');
  const assign = useMutation({
    mutationFn: (policyID: string) => assignPolicy(policyID, 'device', deviceID),
    onSuccess: () => { refetch(); qc.invalidateQueries({ queryKey: ['device', deviceID] }); toast.success('Policy assigned'); }
  });
  const unassign = useMutation({
    mutationFn: (policyID: string) => unassignPolicy(policyID, 'device', deviceID),
    onSuccess: () => { refetch(); toast.success('Device-level override removed'); }
  });

  return (
    <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-medium">Policy</h2>
        {assignedPolicy && (
          <button onClick={() => unassign.mutate(assignedPolicy.id)}
                  className="text-xs px-2 py-1 rounded border hover:bg-slate-50 dark:hover:bg-slate-800">
            Unassign device override
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-slate-500">Resolved:</span>
        <span className="text-sm font-medium">
          {assignedPolicy ? `${assignedPolicy.name} (v${assignedPolicy.version})` : 'none'}
        </span>
        <div className="flex-1 min-w-[140px]" />
        <select value={pick} onChange={e => setPick(e.target.value)}
                className="text-sm rounded border bg-transparent px-2 py-1">
          <option value="">Pick a policy…</option>
          {policies?.map(p => <option key={p.id} value={p.id}>{p.name} (v{p.version})</option>)}
        </select>
        <button disabled={!pick}
                onClick={async () => { await assign.mutateAsync(pick); cmd.mutate({ kind: 'APPLY_POLICY' }); setPick(''); }}
                className="text-sm px-3 py-1.5 rounded bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-40">
          Assign + apply
        </button>
        <button disabled={!assignedPolicy}
                onClick={() => cmd.mutate({ kind: 'APPLY_POLICY' })}
                className="text-sm px-3 py-1.5 rounded border hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40">
          Re-apply
        </button>
      </div>
    </section>
  );
}

function FlashlightToggle({ cmd }: {
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
}) {
  const [on, setOn] = useState(false);
  return (
    <button
      onClick={() => { setOn(!on); cmd.mutate({ kind: 'SET_FLASHLIGHT', payload: { on: !on } }); }}
      className={`text-sm text-left px-3 py-1.5 rounded border transition-colors ${on
        ? 'bg-amber-100 border-amber-400 text-amber-900 dark:bg-amber-950 dark:text-amber-200'
        : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
      Flashlight: {on ? 'ON' : 'off'}
    </button>
  );
}

/* ============================== Apps Tab ============================== */

function AppsTab({ deviceID: _deviceID, inventory, cmd }: {
  deviceID: string;
  inventory: Record<string, unknown> | null;
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
}) {
  const [filter, setFilter] = useState('');
  const [showSystem, setShowSystem] = useState(true);
  const [actOn, setActOn] = useState<Record<string, unknown> | null>(null);

  // Kick a fresh inventory fetch when the tab opens with no cached result.
  useEffect(() => {
    if (!inventory) cmd.mutate({ kind: 'FETCH_APP_INVENTORY' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apps = useMemo(() => {
    const list = (inventory?.apps as Array<Record<string, unknown>>) || [];
    const q = filter.trim().toLowerCase();
    return list
      .filter(a => showSystem || !a.system)
      .filter(a => !q ||
        String(a.label ?? '').toLowerCase().includes(q) ||
        String(a.package ?? '').toLowerCase().includes(q));
  }, [inventory, filter, showSystem]);

  if (!inventory) {
    return (
      <div className="text-center py-10 space-y-3">
        <p className="text-slate-500">No app inventory yet for this device.</p>
        <button onClick={() => cmd.mutate({ kind: 'FETCH_APP_INVENTORY' })}
                className="text-sm px-3 py-1.5 rounded bg-brand-600 hover:bg-brand-700 text-white">
          Fetch app inventory
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input value={filter} onChange={e => setFilter(e.target.value)}
               placeholder="filter by label or package…"
               className="text-sm rounded border bg-transparent px-2 py-1 flex-1" />
        <label className="text-xs text-slate-500 flex items-center gap-1.5 select-none">
          <input type="checkbox" checked={showSystem} onChange={e => setShowSystem(e.target.checked)} />
          show system apps
        </label>
        <button onClick={() => cmd.mutate({ kind: 'FETCH_APP_INVENTORY' })}
                className="text-xs px-2 py-1.5 rounded border hover:bg-slate-50 dark:hover:bg-slate-800">
          Refresh
        </button>
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead className="bg-slate-50 dark:bg-slate-800 text-left text-slate-500 sticky top-[42px]">
            <tr>
              <th className="px-3 py-2 font-normal">Label</th>
              <th className="px-3 py-2 font-normal">Package</th>
              <th className="px-3 py-2 font-normal">Version</th>
              <th className="px-3 py-2 font-normal">Flags</th>
              <th className="px-3 py-2 font-normal text-right w-[280px]">Actions</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((a, i) => {
              const pkg = a.package as string;
              return (
                <tr key={pkg + i} className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/30">
                  <td className="px-3 py-1.5">{a.label as string}</td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-500">{pkg}</td>
                  <td className="px-3 py-1.5">{a.version_name as string} <span className="text-slate-400 text-xs">({String(a.version_code ?? '')})</span></td>
                  <td className="px-3 py-1.5 text-xs text-slate-500">
                    {a.system ? <span className="mr-1 px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800">system</span> : null}
                    {a.enabled === false ? <span className="mr-1 px-1.5 py-0.5 rounded bg-rose-100 text-rose-700">disabled</span> : null}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <div className="inline-flex gap-1 items-center">
                      <button
                        title="Hide from launcher"
                        onClick={() => cmd.mutate({ kind: 'HIDE_APP', payload: { package_name: pkg } })}
                        className="text-xs px-2 py-0.5 rounded border hover:bg-slate-50 dark:hover:bg-slate-800">Hide</button>
                      <button
                        title="Block uninstall"
                        onClick={() => cmd.mutate({ kind: 'BLOCK_UNINSTALL', payload: { package_name: pkg } })}
                        className="text-xs px-2 py-0.5 rounded border hover:bg-slate-50 dark:hover:bg-slate-800">Block</button>
                      <button
                        title="Uninstall this app"
                        onClick={() => { if (confirm(`Uninstall ${a.label}?`)) cmd.mutate({ kind: 'UNINSTALL_APP', payload: { package_name: pkg } }); }}
                        className="text-xs px-2 py-0.5 rounded border border-rose-300 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950">Uninstall</button>
                      <button
                        title="All actions (Show, Allow uninstall, Clear data…)"
                        onClick={() => setActOn(a)}
                        className="text-xs px-2 py-0.5 rounded border hover:bg-slate-50 dark:hover:bg-slate-800">⋯</button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {apps.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">No apps match.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        {apps.length} of {(inventory.count as number) ?? apps.length} apps.
        Fetched {inventory.fetched_at ? new Date(inventory.fetched_at as string).toLocaleString() : '—'}
      </p>
      <DAModeNotice />
      {actOn && <AppActionModal app={actOn} onClose={() => setActOn(null)} cmd={cmd} />}
    </div>
  );
}

function DAModeNotice() {
  return (
    <div className="text-xs text-slate-600 dark:text-slate-400 bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-900 rounded p-2.5">
      <strong>Heads-up:</strong> Hide / Block uninstall / Clear data / silent install require the agent to be running as <b>Device Owner</b>.
      In <b>Device Admin</b> mode the OS prompts the user on the device to approve uninstall and silent install isn't possible.
    </div>
  );
}

function AppActionModal({ app, onClose, cmd }: {
  app: Record<string, unknown>;
  onClose: () => void;
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
}) {
  const pkg = app.package as string;
  const fire = (kind: string, payload?: Record<string, unknown>) => {
    cmd.mutate({ kind, payload: { package_name: pkg, ...(payload || {}) } });
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 w-[440px] space-y-3 shadow-xl">
        <div>
          <div className="font-medium text-lg">{app.label as string}</div>
          <div className="font-mono text-xs text-slate-500">{pkg}</div>
        </div>
        <div className="grid grid-cols-2 gap-2 pt-1">
          <ModalBtn label="Hide from launcher"  desc="App icon removed, package stays installed" onClick={() => fire('HIDE_APP')} />
          <ModalBtn label="Show in launcher"    desc="Reverse of hide"                            onClick={() => fire('SHOW_APP')} />
          <ModalBtn label="Block uninstall"     desc="Prevent user from uninstalling"             onClick={() => fire('BLOCK_UNINSTALL')} />
          <ModalBtn label="Allow uninstall"     desc="Reverse of block"                           onClick={() => fire('ALLOW_UNINSTALL')} />
          <ModalBtn label="Clear app data"      desc="Wipe sharedPrefs, DB, cache (DO only)"      onClick={() => fire('CLEAR_APP_DATA')} />
          <ModalBtn label="Uninstall"           desc="Remove the package (DO silent / DA prompt)" tone="danger" onClick={() => { if (confirm(`Uninstall ${app.label}?`)) fire('UNINSTALL_APP'); }} />
        </div>
        <div className="flex justify-end pt-1">
          <button onClick={onClose} className="text-sm px-3 py-1.5">Close</button>
        </div>
      </div>
    </div>
  );
}

function ModalBtn({ label, desc, onClick, tone }: { label: string; desc: string; onClick: () => void; tone?: 'danger' }) {
  const cls = tone === 'danger'
    ? 'border-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950 text-rose-700 dark:text-rose-300'
    : 'hover:bg-slate-50 dark:hover:bg-slate-800';
  return (
    <button onClick={onClick} className={`text-left rounded border p-2.5 text-xs ${cls}`}>
      <div className="font-medium text-sm">{label}</div>
      <div className="text-slate-500 mt-0.5">{desc}</div>
    </button>
  );
}

/* ============================== Photos Tab ============================== */

function PhotosTab({ deviceID, cmd }: {
  deviceID: string;
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
}) {
  const qc = useQueryClient();
  const { data: photos, isLoading } = useQuery({
    queryKey: ['photos', deviceID],
    queryFn: () => listDevicePhotos(deviceID),
    refetchInterval: 5000
  });
  const [lens, setLens] = useState<'BACK' | 'FRONT'>('BACK');
  const [withFlash, setWithFlash] = useState(false);
  const [preview, setPreview] = useState<{ url: string; id: string } | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => deletePhoto(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['photos', deviceID] }); toast.success('Photo deleted'); }
  });

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
        <h2 className="font-medium mb-3">Capture photo</h2>
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded border overflow-hidden text-sm">
            {(['BACK', 'FRONT'] as const).map(l => (
              <button key={l} onClick={() => setLens(l)}
                      className={`px-3 py-1.5 ${lens === l ? 'bg-brand-600 text-white' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
                {l === 'BACK' ? 'Rear camera' : 'Front (selfie)'}
              </button>
            ))}
          </div>
          <label className="text-sm flex items-center gap-1.5 select-none">
            <input type="checkbox" checked={withFlash} onChange={e => setWithFlash(e.target.checked)} />
            flash
          </label>
          <button
            onClick={() => cmd.mutate({ kind: 'CAPTURE_PHOTO', payload: { lens, with_flash: withFlash } })}
            className="text-sm px-3 py-1.5 rounded bg-brand-600 hover:bg-brand-700 text-white">
            📸 Capture now
          </button>
        </div>
        <p className="text-xs text-slate-500 mt-2">
          Captures a single JPEG. Requires CAMERA permission — auto-granted in Device Owner mode, prompts the user in Device Admin mode.
          Privacy indicator dot appears briefly on Android 12+.
        </p>
      </section>

      <section>
        <h2 className="font-medium mb-3">Gallery</h2>
        {isLoading && <div className="text-sm text-slate-500">Loading…</div>}
        {!isLoading && photos?.length === 0 && (
          <div className="text-center py-10 text-slate-500 text-sm border border-dashed border-slate-200 dark:border-slate-700 rounded-lg">
            No photos captured yet. Click "Capture now" above.
          </div>
        )}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {photos?.map(p => (
            <PhotoThumb key={p.id} photo={p} onOpen={(url) => setPreview({ url, id: p.id })} onDelete={() => { if (confirm('Delete this photo?')) remove.mutate(p.id); }} />
          ))}
        </div>
      </section>
      {preview && <ImagePreview url={preview.url} onClose={() => setPreview(null)} />}
    </div>
  );
}

function PhotoThumb({ photo, onOpen, onDelete }: {
  photo: { id: string; created_at: string; size_bytes: number };
  onOpen: (url: string) => void;
  onDelete: () => void;
}) {
  const { data } = useQuery({
    queryKey: ['photo-url', photo.id],
    queryFn: () => presignPhoto(photo.id),
    staleTime: 8 * 60 * 1000
  });
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
      <button onClick={() => data && onOpen(data.url)} className="block w-full aspect-[4/3] bg-slate-100 dark:bg-slate-800 overflow-hidden">
        {data ? <img src={data.url} alt="" className="w-full h-full object-cover" /> : <div className="w-full h-full animate-pulse" />}
      </button>
      <div className="p-2 text-xs flex items-center justify-between">
        <span className="text-slate-500">{new Date(photo.created_at).toLocaleString()}</span>
        <button onClick={onDelete} className="text-rose-600 hover:underline">delete</button>
      </div>
    </div>
  );
}

function ImagePreview({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center" onClick={onClose}>
      <img src={url} alt="" className="max-w-[95vw] max-h-[95vh] rounded-lg shadow-2xl" />
    </div>
  );
}

/* ============================== Policy Tab ================================ */

function PolicyTab({ deviceID, cmd }: {
  deviceID: string;
  cmd: ReturnType<typeof useMutation<any, any, { kind: string; payload?: Record<string, unknown> }>>;
}) {
  const qc = useQueryClient();
  const { data: effective } = useQuery({
    queryKey: ['resolved-policy', deviceID],
    queryFn:  () => resolvedPolicyForDevice(deviceID),
    refetchInterval: 5000
  });
  const { data: assignments } = useQuery({
    queryKey: ['device-assignments', deviceID],
    queryFn:  () => listAssignmentsForDevice(deviceID),
    refetchInterval: 5000
  });
  const { data: policies } = useQuery({
    queryKey: ['policies'], queryFn: listPolicies
  });

  const [picking, setPicking] = useState(false);
  const assign = useMutation({
    mutationFn: (policyID: string) => assignPolicy(policyID, 'device', deviceID),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resolved-policy', deviceID] });
      qc.invalidateQueries({ queryKey: ['device-assignments', deviceID] });
      qc.invalidateQueries({ queryKey: ['commands', deviceID] });
      toast.success('Policy assigned + APPLY_POLICY queued');
      setPicking(false);
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Assign failed')
  });
  const unassign = useMutation({
    mutationFn: (a: PolicyAssignment) => unassignPolicy(a.policy_id, a.target_kind, a.target_id ?? undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resolved-policy', deviceID] });
      qc.invalidateQueries({ queryKey: ['device-assignments', deviceID] });
      qc.invalidateQueries({ queryKey: ['commands', deviceID] });
      toast.success('Unassigned — device will reconcile shortly');
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Unassign failed')
  });

  // Cross-reference assignment.policy_id → policy name/version using the
  // listPolicies result so each row reads as "PolicyName (v3)" instead of an
  // opaque UUID.
  const policyByID = new Map<string, { name: string; version: number }>();
  (policies ?? []).forEach(p => policyByID.set(p.id, { name: p.name, version: p.version }));

  // Set of policy IDs already bound to this device — so the picker can
  // disable them (re-assigning the same policy is a no-op anyway).
  const boundIDs = new Set<string>((assignments ?? []).map(a => a.policy_id));
  const available = (policies ?? []).filter(p => !boundIDs.has(p.id));

  const kindBadge = (kind: string) => {
    const map: Record<string, string> = {
      device: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
      group:  'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
      tenant: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200'
    };
    return map[kind] ?? map.tenant;
  };

  return (
    <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="font-medium">Policy enforcement</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Multiple policies can be layered. Device-level overrides group-level overrides tenant-level; array fields (URL/app blocklists) union across all layers.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => cmd.mutate({ kind: 'APPLY_POLICY' })}
            className="text-xs px-3 py-1.5 rounded border hover:bg-slate-50 dark:hover:bg-slate-800">
            Re-apply now
          </button>
          <button
            onClick={() => cmd.mutate({ kind: 'CLEAR_POLICY' })}
            className="text-xs px-3 py-1.5 rounded border border-amber-300 text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-950"
            title="Reset every policy-applied setting (camera, restrictions, blocklists, surveillance) on the device.">
            Force clear on device
          </button>
        </div>
      </div>

      {/* Layered assignments list */}
      <div className="rounded-md border border-slate-200 dark:border-slate-800">
        <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Bound policies <span className="text-slate-400">({assignments?.length ?? 0})</span>
          </div>
          <button
            onClick={() => setPicking(p => !p)}
            className="text-xs px-3 py-1 rounded bg-brand-600 hover:bg-brand-700 text-white">
            {picking ? 'Cancel' : '+ Assign another'}
          </button>
        </div>
        {(!assignments || assignments.length === 0) ? (
          <div className="px-3 py-6 text-sm text-slate-500 text-center">
            No policies bound to this device. Tenant-wide assignments still apply automatically.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {assignments.map(a => {
              const meta = policyByID.get(a.policy_id);
              return (
                <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0 flex items-center gap-2">
                    <span className={`text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 ${kindBadge(a.target_kind)}`}>
                      {a.target_kind}
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">
                        {meta?.name ?? a.policy_id.slice(0, 8)}
                      </div>
                      <div className="text-xs text-slate-500">
                        {meta ? `v${meta.version} • ` : ''}assigned {new Date(a.created_at).toLocaleString()}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      if (confirm(`Unassign "${meta?.name ?? a.policy_id}" from this ${a.target_kind}?\n\nIf this is the last policy covering the device, the device will receive CLEAR_POLICY and roll back every setting. Otherwise the device gets APPLY_POLICY and reconciles to the remaining layered policies.`)) {
                        unassign.mutate(a);
                      }
                    }}
                    disabled={unassign.isPending}
                    className="text-xs px-3 py-1.5 rounded border border-rose-300 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950 disabled:opacity-50">
                    Unassign
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Picker */}
      {picking && (
        <div className="rounded-md border border-slate-200 dark:border-slate-800 p-3">
          <div className="text-sm font-medium mb-2">Choose a policy to add</div>
          {available.length === 0 ? (
            <div className="text-sm text-slate-500 py-2">
              {(policies ?? []).length === 0
                ? 'No policies exist. Create one from the Policies page first.'
                : 'Every existing policy is already bound to this device.'}
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {available.map(p => (
                <li key={p.id} className="flex items-center justify-between py-2 gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{p.name}</div>
                    <div className="text-xs text-slate-500">v{p.version}</div>
                  </div>
                  <button
                    onClick={() => assign.mutate(p.id)}
                    disabled={assign.isPending}
                    className="text-xs px-3 py-1 rounded bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white">
                    Assign
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Effective merged spec */}
      {effective && (
        <details className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-3">
          <summary className="text-xs font-medium uppercase tracking-wide text-slate-500 cursor-pointer">
            Effective merged spec — {effective.name} (v{effective.version})
          </summary>
          <pre className="text-xs mt-2 overflow-auto max-h-72 whitespace-pre-wrap break-all">{JSON.stringify(effective.spec, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}

/* ============================== Activity Tab ============================== */

function ActivityTab({ deviceID }: { deviceID: string }) {
  const { data: events, isLoading } = useQuery({
    queryKey: ['device-events', deviceID],
    queryFn:  () => listDeviceEvents(deviceID, 'activity.', 300),
    refetchInterval: 5000
  });
  const [zoom, setZoom] = useState<string | null>(null);

  if (isLoading) return <div className="text-sm text-slate-500 p-4">Loading activity…</div>;
  if (!events || events.length === 0) {
    return (
      <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
        <h2 className="font-medium mb-2">Activity</h2>
        <p className="text-sm text-slate-500">
          No activity events yet. The agent streams screen unlocks, network changes, package installs/removals and (if the policy enables it) unlock-photo events here in real time.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-medium">Activity log</h2>
        <span className="text-xs text-slate-500">{events.length} event{events.length === 1 ? '' : 's'} · auto-refreshes every 5s</span>
      </div>
      <ul className="space-y-1.5">
        {events.map(e => <ActivityRow key={e.id} e={e} onZoom={setZoom} />)}
      </ul>
      {zoom && <ImagePreview url={zoom} onClose={() => setZoom(null)} />}
    </section>
  );
}

function ActivityRow({ e, onZoom }: { e: ActivityEvent; onZoom: (url: string) => void }) {
  const at = new Date(e.captured_at);
  const tone = activityTone(e.kind);
  const label = activityLabel(e.kind);
  const detail = activityDetail(e);

  // Unlock photo: resolve presigned thumbnail on click. The presign endpoint
  // is keyed by file id; we lazy-fetch only when the row is rendered to avoid
  // burning quota on a scroll-past.
  const fileId = (e.payload && (e.payload as any).file_id) as string | undefined;
  const { data: presign } = useQuery({
    queryKey: ['activity-presign', fileId],
    queryFn:  () => presignPhoto(fileId!),
    enabled:  !!fileId
  });

  return (
    <li className="flex items-start gap-3 border-b border-slate-100 dark:border-slate-800 py-1.5">
      <span className={`mt-1 inline-block w-2 h-2 rounded-full shrink-0 ${tone}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-sm">{label}</span>
          {detail && <span className="text-xs text-slate-500 truncate">{detail}</span>}
        </div>
        <div className="text-[11px] text-slate-400">{at.toLocaleString()}</div>
      </div>
      {fileId && presign?.url && (
        <button
          onClick={() => onZoom(presign.url)}
          className="shrink-0 w-16 h-12 rounded overflow-hidden border border-slate-200 dark:border-slate-700 hover:opacity-80">
          <img src={presign.url} alt="unlock capture" className="object-cover w-full h-full" />
        </button>
      )}
    </li>
  );
}

function activityTone(kind: string): string {
  if (kind.startsWith('activity.unlock_photo'))      return 'bg-purple-500';
  if (kind.startsWith('activity.user.present'))      return 'bg-emerald-500';
  if (kind.startsWith('activity.app.foreground'))    return 'bg-teal-500';
  if (kind.startsWith('activity.location'))          return 'bg-fuchsia-500';
  if (kind.startsWith('activity.permission.needed')) return 'bg-orange-500';
  if (kind.startsWith('activity.permission.granted'))return 'bg-emerald-400';
  if (kind.startsWith('activity.screen.on'))         return 'bg-blue-400';
  if (kind.startsWith('activity.screen.off'))        return 'bg-slate-400';
  if (kind.startsWith('activity.power'))             return 'bg-amber-400';
  if (kind.startsWith('activity.network'))           return 'bg-sky-500';
  if (kind.startsWith('activity.package'))           return 'bg-indigo-500';
  if (kind.startsWith('activity.boot'))              return 'bg-rose-500';
  if (kind.startsWith('activity.monitor'))           return 'bg-cyan-500';
  return 'bg-slate-400';
}

function activityLabel(kind: string): string {
  switch (kind) {
    case 'activity.screen.on':           return 'Screen on';
    case 'activity.screen.off':          return 'Screen off';
    case 'activity.user.present':        return 'Device unlocked';
    case 'activity.power.connected':     return 'Charger connected';
    case 'activity.power.disconnected':  return 'Charger disconnected';
    case 'activity.network.change':      return 'Network change';
    case 'activity.package.added':       return 'App installed';
    case 'activity.package.removed':     return 'App uninstalled';
    case 'activity.package.replaced':    return 'App updated';
    case 'activity.boot':                return 'Device booted';
    case 'activity.unlock_photo':        return 'Unlock photo captured';
    case 'activity.app.foreground':      return 'App opened';
    case 'activity.location':            return 'Location';
    case 'activity.permission.needed':   return 'Permission needed';
    case 'activity.permission.granted':  return 'Permission granted';
    case 'activity.monitor.started':     return 'Activity monitor online';
    default:                             return kind;
  }
}

function activityDetail(e: ActivityEvent): string {
  const p = (e.payload || {}) as any;
  switch (e.kind) {
    case 'activity.app.foreground':
      return p.app_label ? `${p.app_label} (${p.package})` : (p.package ?? '');
    case 'activity.location':
      if (typeof p.latitude === 'number' && typeof p.longitude === 'number') {
        const acc = typeof p.accuracy_m === 'number' ? ` ±${Math.round(p.accuracy_m)}m` : '';
        return `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}${acc}`;
      }
      return '';
    case 'activity.network.change':
      if (typeof p.transport === 'string') {
        const inet = p.has_internet === false ? ' • no internet' : '';
        const vpn  = p.vpn ? ' • VPN' : '';
        return `${p.transport}${inet}${vpn}`;
      }
      return '';
    case 'activity.permission.needed':
      return p.hint ? `${p.permission}: ${p.hint}` : (p.permission ?? '');
    case 'activity.permission.granted':
      return p.permission ?? '';
    case 'activity.package.added':
    case 'activity.package.removed':
    case 'activity.package.replaced':
      return p.app_label ? `${p.app_label} (${p.package})` : (p.package ?? '');
    case 'activity.unlock_photo':
      if (p.error) return `failed: ${p.error}`;
      if (p.lens) return `lens: ${p.lens}`;
      return '';
  }
  return '';
}

/* ============================== Commands Tab ============================== */

function CommandsTab({ commands }: { commands: CommandRow[] | undefined }) {
  return (
    <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <h2 className="font-medium mb-3">Command history</h2>
      <table className="w-full text-sm">
        <thead className="text-left text-slate-500">
          <tr>
            <th className="font-normal py-1">Kind</th>
            <th className="font-normal py-1">State</th>
            <th className="font-normal py-1">Attempts</th>
            <th className="font-normal py-1">Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {commands?.length === 0 && <tr><td colSpan={5} className="py-3 text-slate-400">No commands yet.</td></tr>}
          {commands?.map(c => <CommandHistoryRow key={c.id} c={c} />)}
        </tbody>
      </table>
    </section>
  );
}

function CommandHistoryRow({ c }: { c: CommandRow }) {
  const [open, setOpen] = useState(false);
  const expandable = c.result != null || (c.last_error && c.last_error.length > 0);
  return (
    <>
      <tr className="border-t border-slate-100 dark:border-slate-800">
        <td className="py-1 font-mono text-xs">{c.kind}</td>
        <td className="py-1"><StateBadge state={c.state} /></td>
        <td className="py-1 text-xs">{c.attempts}</td>
        <td className="py-1 text-xs text-slate-500">{new Date(c.created_at).toLocaleTimeString()}</td>
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
            {c.last_error && <div className="mb-2 text-xs text-rose-600">Error: {c.last_error}</div>}
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

/* ============================== Shared bits ============================== */

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-lg font-semibold mt-0.5">{value}</div>
      {hint && <div className="text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

function ActionGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">{title}</div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function ActionBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-sm text-left px-3 py-1.5 rounded border hover:bg-slate-50 dark:hover:bg-slate-800">{label}</button>
  );
}

function ResetPasswordBtn({ onSubmit }: { onSubmit: (pw: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState('');
  return (
    <>
      <button onClick={() => setOpen(true)} className="text-sm text-left px-3 py-1.5 rounded border hover:bg-slate-50 dark:hover:bg-slate-800">
        Reset password…
      </button>
      {open && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setOpen(false)}>
          <div onClick={e => e.stopPropagation()}
               className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 w-[420px] space-y-3 shadow-xl">
            <div className="font-medium">Reset device password</div>
            <p className="text-xs text-slate-500">
              Requires Device Owner on Android 8+. In Device Admin mode this works only if no password is currently set.
            </p>
            <input type="text" value={pw} onChange={e => setPw(e.target.value)}
                   placeholder="New password (min 4 chars)"
                   className="block w-full rounded border bg-transparent px-3 py-2 text-sm" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setOpen(false)} className="text-sm px-3 py-1.5">Cancel</button>
              <button onClick={() => { onSubmit(pw); setOpen(false); setPw(''); }}
                      className="text-sm px-3 py-1.5 rounded bg-brand-600 hover:bg-brand-700 text-white">Reset</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function WipeBtn({ onConfirm }: { onConfirm: () => void }) {
  return (
    <button
      onClick={() => { const t = prompt('Type WIPE to factory-reset this device:'); if (t === 'WIPE') onConfirm(); }}
      className="text-sm text-left px-3 py-1.5 rounded border border-rose-300 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950">
      Factory wipe…
    </button>
  );
}

function LiveLocationCard({ device }: { device: Device }) {
  if (device.last_latitude == null || device.last_longitude == null) {
    return (
      <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
        <h2 className="font-medium mb-1">Live location</h2>
        <p className="text-sm text-slate-500">
          No location reported yet. The agent piggybacks a GPS fix on each heartbeat (refreshed every ~5 min).
          Make sure location is enabled on the device and ACCESS_FINE_LOCATION is granted (auto-granted in DO mode).
        </p>
      </section>
    );
  }
  const lat = device.last_latitude;
  const lng = device.last_longitude;
  const acc = device.last_location_accuracy_m;
  const at = device.last_location_at;
  const mapURL = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
  const embedSrc = `https://www.openstreetmap.org/export/embed.html?bbox=${lng - 0.005},${lat - 0.003},${lng + 0.005},${lat + 0.003}&layer=mapnik&marker=${lat},${lng}`;
  return (
    <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-medium">Live location</h2>
        <span className="text-xs text-slate-500">{formatRelative(at)}</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="text-sm">
          <div className="text-xs text-slate-500">Coordinates</div>
          <code className="text-xs">{lat.toFixed(5)}, {lng.toFixed(5)}</code>
          {acc != null && <div className="text-xs text-slate-500 mt-1">±{Math.round(acc)} m</div>}
          <a href={mapURL} target="_blank" rel="noreferrer" className="text-xs text-brand-600 hover:underline mt-2 inline-block">
            Open in OpenStreetMap →
          </a>
        </div>
        <div className="md:col-span-2 rounded overflow-hidden border border-slate-200 dark:border-slate-800">
          <iframe
            title="map"
            src={embedSrc}
            className="w-full h-48 block"
            style={{ border: 0 }}
            referrerPolicy="no-referrer-when-downgrade"
            loading="lazy" />
        </div>
      </div>
    </section>
  );
}

function ConnectionPill({ online, lastHeartbeat }: { online: boolean; lastHeartbeat?: string }) {
  if (online) {
    return (
      <span title={`Last heartbeat ${formatRelative(lastHeartbeat)}`}
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        Connected
      </span>
    );
  }
  return (
    <span title={lastHeartbeat ? `Last seen ${formatRelative(lastHeartbeat)}` : 'Never heartbeated'}
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
      <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
      Disconnected {lastHeartbeat ? `· ${formatRelative(lastHeartbeat)}` : ''}
    </span>
  );
}

function StateBadge({ state }: { state: string }) {
  const map: Record<string, string> = {
    enrolled: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
    offline:  'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    pending:  'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    wiped:    'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
    retired:  'bg-slate-100 text-slate-500',
    succeeded:    'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
    failed:       'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
    timed_out:    'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    dispatched:   'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
    acknowledged: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300'
  };
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] uppercase tracking-wide ${map[state] ?? ''}`}>{state}</span>;
}

function DeviceInfoCard({ info }: { info: Record<string, unknown> | null }) {
  if (!info) return null;
  const rows: Array<[string, React.ReactNode]> = [
    ['Manufacturer', info.manufacturer as string],
    ['Model', info.model as string],
    ['Android', `${info.android_version ?? '—'} (SDK ${info.sdk ?? '?'})`],
    ['Patch level', info.patch_level as string],
    ['Storage', formatStorage(info.storage_free_bytes as number, info.storage_total_bytes as number)],
    ['Battery', info.battery_pct != null ? `${info.battery_pct}%${info.charging ? ' (charging)' : ''}` : '—'],
    ['Network', `${(info.network as string) ?? '—'}${info.wifi_ssid ? ` · ${info.wifi_ssid}` : ''}`],
    ['IP address', info.ip_address ? <code className="text-xs">{info.ip_address as string}</code> : '—'],
    ['MAC address', info.mac_address ? <code className="text-xs">{info.mac_address as string}</code> : '—'],
    ['Agent', `${info.agent_version ?? '—'}${info.device_owner ? ' • Device Owner' : info.admin_active ? ' • Device Admin' : ''}`],
    ['Integrity', renderFlags(info)],
    ['Fetched', info.fetched_at ? new Date(info.fetched_at as string).toLocaleString() : '—']
  ];
  return (
    <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <h2 className="font-medium mb-3">Device info</h2>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 border-b border-slate-100 dark:border-slate-800 py-1">
            <dt className="text-slate-500">{k}</dt>
            <dd className="text-right">{v ?? '—'}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function renderFlags(info: Record<string, unknown>) {
  const flags: Array<[string, boolean]> = [
    ['rooted', !!info.rooted], ['debuggable', !!info.debuggable],
    ['emulator', !!info.emulator], ['adb', !!info.adb_enabled]
  ];
  const on = flags.filter(([, v]) => v).map(([k]) => k);
  if (on.length === 0) return <span className="text-emerald-600">clean</span>;
  return <span className="text-rose-600">{on.join(', ')}</span>;
}

function formatStorage(free?: number, total?: number) {
  if (!total) return '—';
  const fmt = (b: number) => (b / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  return free != null ? `${fmt(free)} free of ${fmt(total)}` : fmt(total);
}

function Skeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-6 w-1/3 bg-slate-200 dark:bg-slate-800 rounded" />
      <div className="h-4 w-1/4 bg-slate-200 dark:bg-slate-800 rounded" />
      <div className="h-24 bg-slate-100 dark:bg-slate-900 rounded-lg" />
      <div className="h-48 bg-slate-100 dark:bg-slate-900 rounded-lg" />
    </div>
  );
}
