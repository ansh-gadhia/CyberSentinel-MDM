import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  assignPolicy, deletePolicy, listAssignmentsFor, listPolicies, savePolicy, type Policy
} from '../api/policies';
import { useMemo, useState } from 'react';

// The Android agent (PolicySpec.kt) decodes with ignoreUnknownKeys=true, so any
// field placed at the wrong nesting level is silently dropped. We learned this
// the hard way: a hand-written policy with top-level url_blocklist looked like
// it saved fine, but the device never blocked anything because the agent's
// AppPolicy expects apps.url_blocklist. The structured editor below builds the
// JSON in the canonical shape so users can't put things in the wrong place.

const RESTRICTIONS: Array<{ key: string; label: string; hint?: string }> = [
  { key: 'disable_camera', label: 'Disable camera' },
  { key: 'disable_screen_capture', label: 'Disable screen capture' },
  { key: 'disable_usb_file_transfer', label: 'Disable USB file transfer' },
  { key: 'disable_bluetooth', label: 'Disable Bluetooth' },
  { key: 'disable_nfc', label: 'Disable NFC' },
  { key: 'disable_hotspot', label: 'Disable Wi-Fi hotspot' },
  { key: 'disable_location', label: 'Disable location' },
  { key: 'disable_unknown_sources', label: 'Block installs from unknown sources' },
  { key: 'disable_accessibility', label: 'Disable accessibility services' },
  { key: 'disable_factory_reset', label: 'Block factory reset' },
  { key: 'disable_safe_boot', label: 'Block safe boot' },
  { key: 'disable_add_user', label: 'Block adding users' }
];

const TEMPLATES: Array<{ label: string; spec: Record<string, unknown> }> = [
  {
    label: 'Disable camera + 4-digit PIN',
    spec: {
      restrictions: { disable_camera: true },
      password: { complexity: 65536, minimum_length: 4 }
    }
  },
  {
    label: 'Lockdown (no camera, no USB, no unknown sources)',
    spec: {
      restrictions: {
        disable_camera: true, disable_usb_file_transfer: true,
        disable_unknown_sources: true, disable_screen_capture: true
      }
    }
  },
  {
    label: 'Block YouTube (app + Chrome URLs)',
    spec: {
      apps: {
        blocklist: [
          'com.google.android.youtube',
          'com.google.android.apps.youtube.kids',
          'com.google.android.apps.youtube.music'
        ],
        url_blocklist: [
          'youtube.com', '*.youtube.com', 'youtu.be', '*.googlevideo.com'
        ]
      }
    }
  },
  {
    label: 'Block social media (Instagram, FB, X, TikTok)',
    spec: {
      apps: {
        blocklist: [
          'com.instagram.android', 'com.facebook.katana', 'com.facebook.lite',
          'com.twitter.android', 'com.zhiliaoapp.musically'
        ],
        url_blocklist: [
          '*.instagram.com', 'instagram.com',
          '*.facebook.com', 'facebook.com',
          '*.twitter.com', 'twitter.com', '*.x.com', 'x.com',
          '*.tiktok.com', 'tiktok.com'
        ]
      }
    }
  },
  { label: 'Capture front photo on every unlock', spec: { security: { capture_on_unlock: true } } },
  {
    label: 'Compliance baseline',
    spec: { compliance: { require_encryption: true, block_rooted: true } }
  }
];

interface FormState {
  restrictions: Record<string, boolean>;
  appBlocklist: string;           // one package per line
  urlBlocklist: string;           // one pattern per line
  captureOnUnlock: boolean;
  advancedJson: string;           // any fields the form doesn't cover
}

// Decompose a spec into form fields, peeling off whatever the structured UI
// represents and leaving the rest as advanced JSON. Round-trips losslessly:
// build(decompose(s)) ≅ s for any valid s.
function decompose(spec: Record<string, unknown>): FormState {
  const s: any = { ...spec };
  const restrictionsObj = (s.restrictions ?? {}) as Record<string, boolean>;
  const restrictions: Record<string, boolean> = {};
  for (const r of RESTRICTIONS) {
    if (restrictionsObj[r.key] === true) restrictions[r.key] = true;
  }
  delete s.restrictions;

  const apps: any = { ...(s.apps ?? {}) };
  const appBlocklist = Array.isArray(apps.blocklist) ? (apps.blocklist as string[]).join('\n') : '';
  const urlBlocklist = Array.isArray(apps.url_blocklist) ? (apps.url_blocklist as string[]).join('\n') : '';
  delete apps.blocklist;
  delete apps.url_blocklist;
  if (Object.keys(apps).length > 0) s.apps = apps; else delete s.apps;

  const security: any = { ...(s.security ?? {}) };
  const captureOnUnlock = security.capture_on_unlock === true;
  delete security.capture_on_unlock;
  if (Object.keys(security).length > 0) s.security = security; else delete s.security;

  return {
    restrictions,
    appBlocklist,
    urlBlocklist,
    captureOnUnlock,
    advancedJson: JSON.stringify(s, null, 2)
  };
}

function build(form: FormState): { ok: true; spec: Record<string, unknown> } | { ok: false; err: string } {
  let extras: Record<string, unknown> = {};
  const adv = form.advancedJson.trim();
  if (adv && adv !== '{}') {
    try {
      const parsed = JSON.parse(adv);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, err: 'Advanced JSON must be a JSON object.' };
      }
      extras = parsed;
    } catch (e: any) {
      return { ok: false, err: `Advanced JSON is invalid: ${e?.message ?? e}` };
    }
  }
  // Top-level legacy fields people sometimes hand-write — auto-nest them so
  // the agent actually sees them.
  if (Array.isArray((extras as any).url_blocklist) || Array.isArray((extras as any).blocklist)) {
    const a: any = { ...((extras as any).apps ?? {}) };
    if ((extras as any).url_blocklist) { a.url_blocklist = (extras as any).url_blocklist; delete (extras as any).url_blocklist; }
    if ((extras as any).blocklist) { a.blocklist = (extras as any).blocklist; delete (extras as any).blocklist; }
    (extras as any).apps = a;
  }

  const spec: Record<string, unknown> = { ...extras };

  const enabledRestrictions = Object.entries(form.restrictions)
    .filter(([, v]) => v).reduce((acc, [k]) => { acc[k] = true; return acc; }, {} as Record<string, boolean>);
  if (Object.keys(enabledRestrictions).length > 0) {
    spec.restrictions = { ...(spec.restrictions as object ?? {}), ...enabledRestrictions };
  }

  const apps: any = { ...((spec.apps as object) ?? {}) };
  const appList = form.appBlocklist.split('\n').map(s => s.trim()).filter(Boolean);
  const urlList = form.urlBlocklist.split('\n').map(s => s.trim()).filter(Boolean);
  if (appList.length) apps.blocklist = appList;
  if (urlList.length) apps.url_blocklist = urlList;
  if (Object.keys(apps).length > 0) spec.apps = apps;

  if (form.captureOnUnlock) {
    spec.security = { ...((spec.security as object) ?? {}), capture_on_unlock: true };
  }

  return { ok: true, spec };
}

export function Policies() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['policies'], queryFn: listPolicies });
  const [editor, setEditor] = useState<{ id?: string; name: string; form: FormState } | null>(null);
  const [view, setView] = useState<Policy | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      if (!editor) throw new Error('no editor');
      if (!editor.name.trim()) throw new Error('Policy name is required.');
      const built = build(editor.form);
      if (!built.ok) throw new Error(built.err);
      return savePolicy({ id: editor.id, name: editor.name.trim(), spec: built.spec });
    },
    onMutate: () => setSaveErr(null),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['policies'] }); setEditor(null); },
    onError: (e: any) => {
      const msg = e?.response?.data?.error ?? e?.message ?? String(e);
      setSaveErr(msg);
    }
  });
  const remove = useMutation({
    mutationFn: (id: string) => deletePolicy(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['policies'] })
  });
  const assignTenant = useMutation({
    mutationFn: (id: string) => assignPolicy(id, 'tenant'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['policies'] })
  });

  function openNew(name = '', spec: Record<string, unknown> = {}) {
    setSaveErr(null);
    setEditor({ name, form: decompose(spec) });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Policies</h1>
        <div className="flex gap-2">
          <select
            onChange={e => {
              const t = TEMPLATES[+e.target.value];
              if (t) openNew(t.label, t.spec);
              e.currentTarget.value = '';
            }}
            className="rounded border px-2 py-1.5 bg-transparent text-sm">
            <option value="">From template…</option>
            {TEMPLATES.map((t, i) => <option key={t.label} value={i}>{t.label}</option>)}
          </select>
          <button
            onClick={() => openNew()}
            className="bg-brand-600 hover:bg-brand-700 text-white text-sm px-3 py-1.5 rounded">
            + New
          </button>
        </div>
      </div>

      {editor && (
        <PolicyEditor
          editor={editor}
          setEditor={setEditor}
          saving={save.isPending}
          saveErr={saveErr}
          onCancel={() => { setEditor(null); setSaveErr(null); }}
          onSave={() => save.mutate()}
        />
      )}

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800 text-left text-slate-500">
            <tr>
              <th className="px-4 py-2 font-normal">Name</th>
              <th className="px-4 py-2 font-normal">Version</th>
              <th className="px-4 py-2 font-normal">Updated</th>
              <th className="px-4 py-2 font-normal text-right"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-400">loading…</td></tr>}
            {!isLoading && data?.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-400">No policies yet. Create one from a template or "+ New".</td></tr>
            )}
            {data?.map(p => (
              <tr key={p.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2">{p.name}</td>
                <td className="px-4 py-2 text-xs text-slate-500">v{p.version}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{new Date(p.updated_at).toLocaleString()}</td>
                <td className="px-4 py-2 text-right">
                  <div className="inline-flex gap-2">
                    <button onClick={() => setView(p)}
                            className="text-xs px-2 py-1 rounded border hover:bg-slate-50 dark:hover:bg-slate-800">View</button>
                    <button onClick={() => { setSaveErr(null); setEditor({ id: p.id, name: p.name, form: decompose(p.spec) }); }}
                            className="text-xs px-2 py-1 rounded border hover:bg-slate-50 dark:hover:bg-slate-800">Edit</button>
                    <button onClick={() => { if (confirm(`Assign "${p.name}" to ALL devices in your tenant?`)) assignTenant.mutate(p.id); }}
                            className="text-xs px-2 py-1 rounded border hover:bg-slate-50 dark:hover:bg-slate-800">Assign to tenant</button>
                    <button onClick={() => { if (confirm(`Delete policy "${p.name}"? Assignments to it will be removed.`)) remove.mutate(p.id); }}
                            className="text-xs px-2 py-1 rounded border border-rose-300 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950">Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {view && <PolicyViewer p={view} onClose={() => setView(null)} />}
    </div>
  );
}

function PolicyEditor({
  editor, setEditor, saving, saveErr, onCancel, onSave
}: {
  editor: { id?: string; name: string; form: FormState };
  setEditor: (e: { id?: string; name: string; form: FormState }) => void;
  saving: boolean;
  saveErr: string | null;
  onCancel: () => void;
  onSave: () => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(editor.form.advancedJson.trim() !== '{}');
  const setForm = (patch: Partial<FormState>) =>
    setEditor({ ...editor, form: { ...editor.form, ...patch } });

  const previewSpec = useMemo(() => {
    const built = build(editor.form);
    return built.ok ? JSON.stringify(built.spec, null, 2) : `// ${built.err}`;
  }, [editor.form]);

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-4">
      <div>
        <label className="block text-xs uppercase tracking-wide text-slate-500 mb-1">Policy name</label>
        <input value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })}
               placeholder="e.g. Block social media"
               className="block w-full rounded border px-3 py-2 bg-transparent" />
      </div>

      <div>
        <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">Restrictions</div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1.5 text-sm">
          {RESTRICTIONS.map(r => (
            <label key={r.key} className="inline-flex items-center gap-2 cursor-pointer">
              <input type="checkbox"
                     checked={!!editor.form.restrictions[r.key]}
                     onChange={e => setForm({ restrictions: { ...editor.form.restrictions, [r.key]: e.target.checked } })} />
              <span>{r.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">App blocklist</div>
          <div className="text-xs text-slate-500 mb-1">One Android package name per line. E.g. <code>com.instagram.android</code>.</div>
          <textarea value={editor.form.appBlocklist} onChange={e => setForm({ appBlocklist: e.target.value })}
                    placeholder="com.example.app"
                    className="block w-full h-32 rounded border px-3 py-2 font-mono text-xs bg-transparent" />
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">URL blocklist (Chrome / Edge / Brave)</div>
          <div className="text-xs text-slate-500 mb-1">One pattern per line. E.g. <code>youtube.com</code>, <code>*.youtube.com</code>, <code>*://*.tiktok.com/*</code>.</div>
          <textarea value={editor.form.urlBlocklist} onChange={e => setForm({ urlBlocklist: e.target.value })}
                    placeholder="example.com"
                    className="block w-full h-32 rounded border px-3 py-2 font-mono text-xs bg-transparent" />
        </div>
      </div>

      <div>
        <label className="inline-flex items-center gap-2 cursor-pointer text-sm">
          <input type="checkbox"
                 checked={editor.form.captureOnUnlock}
                 onChange={e => setForm({ captureOnUnlock: e.target.checked })} />
          <span>Capture front-camera photo on every unlock</span>
        </label>
      </div>

      <div>
        <button onClick={() => setShowAdvanced(v => !v)}
                className="text-xs text-slate-500 underline">
          {showAdvanced ? 'Hide' : 'Show'} advanced JSON (password, network, compliance, etc.)
        </button>
        {showAdvanced && (
          <textarea value={editor.form.advancedJson} onChange={e => setForm({ advancedJson: e.target.value })}
                    placeholder='{"password": {"complexity": 65536}}'
                    className="block w-full h-32 mt-2 rounded border px-3 py-2 font-mono text-xs bg-transparent" />
        )}
      </div>

      <div>
        <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Effective JSON sent to device</div>
        <pre className="text-xs bg-slate-50 dark:bg-slate-950 rounded p-3 overflow-auto max-h-40">{previewSpec}</pre>
      </div>

      {saveErr && (
        <div className="rounded border border-rose-300 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
          {saveErr}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-3 py-1.5 text-sm">Cancel</button>
        <button onClick={onSave} disabled={saving}
                className="bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white text-sm px-3 py-1.5 rounded">
          {saving ? 'Saving…' : (editor.id ? 'Save new version' : 'Save')}
        </button>
      </div>
    </div>
  );
}

function PolicyViewer({ p, onClose }: { p: Policy; onClose: () => void }) {
  const { data: assignments } = useQuery({
    queryKey: ['policy-assignments', p.id],
    queryFn: () => listAssignmentsFor(p.id)
  });
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 w-[640px] max-h-[80vh] overflow-auto space-y-3 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-medium text-lg">{p.name}</div>
            <div className="text-xs text-slate-500">v{p.version} • updated {new Date(p.updated_at).toLocaleString()}</div>
          </div>
          <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-900 dark:hover:text-white">close</button>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Spec</div>
          <pre className="text-xs bg-slate-50 dark:bg-slate-950 rounded p-3 overflow-auto max-h-80">{JSON.stringify(p.spec, null, 2)}</pre>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Assignments</div>
          {!assignments?.length && <div className="text-sm text-slate-400">No active assignments.</div>}
          <ul className="space-y-1 text-sm">
            {assignments?.map(a => (
              <li key={a.id}>
                {a.target_kind}{a.target_id ? `: ${a.target_id.slice(0, 8)}…` : ''}
                <span className="text-xs text-slate-500 ml-2">{new Date(a.created_at).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
