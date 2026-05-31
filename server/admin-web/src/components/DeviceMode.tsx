// Management-mode display helpers. The agent reports its current privilege
// level on every heartbeat as 'owner' | 'admin' | 'none'; the UI renders a live
// badge and a capability matrix so operators can see exactly what the device
// can and can't do in its current mode.

export type MgmtMode = 'owner' | 'admin' | 'none';

export function normalizeMode(m?: string | null): MgmtMode {
  return m === 'owner' || m === 'admin' ? m : 'none';
}

const MODE_LABEL: Record<MgmtMode, string> = {
  owner: 'Device Owner',
  admin: 'Device Admin',
  none: 'Enrolled only'
};

const MODE_TONE: Record<MgmtMode, string> = {
  owner: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  admin: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  none: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
};

const MODE_BLURB: Record<MgmtMode, string> = {
  owner: 'Full Device Owner control — every remote action and policy works, and camera/mic/location are auto-granted for headless use.',
  admin: 'Legacy Device Admin — lock, wipe and password policy work, but silent app management, restrictions, VPN/proxy and headless sensors do not.',
  none: 'Installed and enrolled with no admin/owner rights. Read-only inventory + telemetry only; sensors work only if the user grants the runtime permission. No enforcement.'
};

export function modeLabel(m?: string | null) { return MODE_LABEL[normalizeMode(m)]; }

// Capability → modes that can perform it. Used to disable remote-action
// buttons that would just fail server-side in the device's current mode.
export type Capability =
  | 'lock' | 'reboot' | 'wipe' | 'reset_password'
  | 'app_uninstall' | 'app_manage';

const CAP_MODES: Record<Capability, MgmtMode[]> = {
  lock:           ['admin', 'owner'],
  wipe:           ['admin', 'owner'],
  reset_password: ['admin', 'owner'],
  reboot:         ['owner'],
  app_uninstall:  ['admin', 'owner'],
  app_manage:     ['owner'] // hide/show, block/allow uninstall, clear data
};

const CAP_REQ: Record<Capability, string> = {
  lock:           'Requires Device Admin or Device Owner',
  wipe:           'Requires Device Admin or Device Owner',
  reset_password: 'Requires Device Admin or Device Owner',
  reboot:         'Requires Device Owner',
  app_uninstall:  'Requires Device Admin or Device Owner',
  app_manage:     'Requires Device Owner'
};

export function modeAllows(mode: string | null | undefined, cap: Capability): boolean {
  return CAP_MODES[cap].includes(normalizeMode(mode));
}

// Returns a tooltip explaining the requirement when the mode is insufficient,
// or undefined when the action is allowed.
export function modeRequirement(mode: string | null | undefined, cap: Capability): string | undefined {
  return modeAllows(mode, cap) ? undefined : CAP_REQ[cap];
}

export function ModeBadge({ mode, className = '' }: { mode?: string | null; className?: string }) {
  const k = normalizeMode(mode);
  return (
    <span title={MODE_BLURB[k]}
          className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${MODE_TONE[k]} ${className}`}>
      {MODE_LABEL[k]}
    </span>
  );
}

// Per-capability support across the three modes.
//   yes    — works headlessly / fully
//   manual — works only if the user has granted the runtime permission on-device
//   prompt — works but the user is prompted on-device (no silent action)
//   no     — unavailable in this mode
type Support = 'yes' | 'manual' | 'prompt' | 'no';

interface CapRow { label: string; none: Support; admin: Support; owner: Support }

const CAPS: CapRow[] = [
  { label: 'Heartbeat, network/storage/battery telemetry', none: 'yes', admin: 'yes', owner: 'yes' },
  { label: 'App inventory listing', none: 'yes', admin: 'yes', owner: 'yes' },
  { label: 'Foreground-app activity log', none: 'manual', admin: 'manual', owner: 'manual' },
  { label: 'Location / Camera photo / Mic audio', none: 'manual', admin: 'manual', owner: 'yes' },
  { label: 'Lock screen', none: 'no', admin: 'yes', owner: 'yes' },
  { label: 'Factory wipe', none: 'no', admin: 'yes', owner: 'yes' },
  { label: 'Password policy / reset', none: 'no', admin: 'prompt', owner: 'yes' },
  { label: 'Disable camera (policy)', none: 'no', admin: 'yes', owner: 'yes' },
  { label: 'Reboot device', none: 'no', admin: 'no', owner: 'yes' },
  { label: 'Install / uninstall apps', none: 'no', admin: 'prompt', owner: 'yes' },
  { label: 'Hide / show app, block uninstall', none: 'no', admin: 'no', owner: 'yes' },
  { label: 'User restrictions, VPN, proxy, CA certs', none: 'no', admin: 'no', owner: 'yes' },
  { label: 'Clear other apps’ data', none: 'no', admin: 'no', owner: 'yes' }
];

const CELL: Record<Support, { txt: string; cls: string }> = {
  yes:    { txt: '✓',       cls: 'text-emerald-600 dark:text-emerald-400' },
  manual: { txt: 'if granted', cls: 'text-amber-600 dark:text-amber-400 text-[10px]' },
  prompt: { txt: 'prompts',  cls: 'text-amber-600 dark:text-amber-400 text-[10px]' },
  no:     { txt: '—',        cls: 'text-slate-300 dark:text-slate-600' }
};

export function ModeCapabilityCard({ mode }: { mode?: string | null }) {
  const k = normalizeMode(mode);
  const colCls = (m: MgmtMode) =>
    m === k ? 'bg-brand-50 dark:bg-brand-950/40 font-medium' : '';
  return (
    <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div className="flex items-center gap-2 mb-1">
        <h2 className="font-medium">Management mode</h2>
        <ModeBadge mode={mode} />
      </div>
      <p className="text-xs text-slate-500 mb-3">{MODE_BLURB[k]}</p>
      {k !== 'owner' && (
        <div className="text-xs text-slate-600 dark:text-slate-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded p-2.5 mb-3">
          {k === 'none'
            ? 'To enable enforcement, promote the agent to Device Admin (Settings → Security → Device admin apps) or, for full control, Device Owner.'
            : 'For silent app management, restrictions, VPN/proxy and headless camera/mic, provision as Device Owner (adb dpm set-device-owner on a freshly reset device, or QR enrollment).'}
          {' '}This updates here automatically within a heartbeat once changed.
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[480px]">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="font-normal py-1">Capability</th>
              <th className={`font-normal py-1 px-2 text-center ${colCls('none')}`}>Enrolled</th>
              <th className={`font-normal py-1 px-2 text-center ${colCls('admin')}`}>Admin</th>
              <th className={`font-normal py-1 px-2 text-center ${colCls('owner')}`}>Owner</th>
            </tr>
          </thead>
          <tbody>
            {CAPS.map(r => (
              <tr key={r.label} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1 pr-2">{r.label}</td>
                {(['none', 'admin', 'owner'] as MgmtMode[]).map(m => {
                  const c = CELL[r[m]];
                  return <td key={m} className={`py-1 px-2 text-center ${colCls(m)}`}><span className={c.cls}>{c.txt}</span></td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
