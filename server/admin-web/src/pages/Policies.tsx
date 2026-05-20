import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  assignPolicy, deletePolicy, listAssignmentsFor, listPolicies, savePolicy, type Policy
} from '../api/policies';
import { useState } from 'react';

const TEMPLATES: Array<{ label: string; spec: object }> = [
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
          'youtube.com',
          '*.youtube.com',
          'youtu.be',
          '*.googlevideo.com'
        ]
      }
    }
  },
  {
    label: 'Block social media (Instagram, FB, X, TikTok)',
    spec: {
      apps: {
        blocklist: [
          'com.instagram.android',
          'com.facebook.katana',
          'com.facebook.lite',
          'com.twitter.android',
          'com.zhiliaoapp.musically'
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
  {
    label: 'Capture front photo on every unlock',
    spec: {
      security: { capture_on_unlock: true }
    }
  },
  {
    label: 'Compliance baseline',
    spec: {
      compliance: { require_encryption: true, block_rooted: true }
    }
  }
];

export function Policies() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['policies'], queryFn: listPolicies });
  const [editor, setEditor] = useState<{ id?: string; name: string; spec: string } | null>(null);
  const [view, setView] = useState<Policy | null>(null);

  const save = useMutation({
    mutationFn: () => {
      if (!editor) throw new Error('no editor');
      const spec = JSON.parse(editor.spec);
      return savePolicy({ id: editor.id, name: editor.name, spec });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['policies'] }); setEditor(null); }
  });
  const remove = useMutation({
    mutationFn: (id: string) => deletePolicy(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['policies'] })
  });
  const assignTenant = useMutation({
    mutationFn: (id: string) => assignPolicy(id, 'tenant'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['policies'] })
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Policies</h1>
        <div className="flex gap-2">
          <select
            onChange={e => {
              const t = TEMPLATES[+e.target.value];
              if (t) setEditor({ name: t.label, spec: JSON.stringify(t.spec, null, 2) });
              e.currentTarget.value = '';
            }}
            className="rounded border px-2 py-1.5 bg-transparent text-sm">
            <option value="">From template…</option>
            {TEMPLATES.map((t, i) => <option key={t.label} value={i}>{t.label}</option>)}
          </select>
          <button
            onClick={() => setEditor({ name: '', spec: '{\n  "restrictions": { "disable_camera": false }\n}' })}
            className="bg-brand-600 hover:bg-brand-700 text-white text-sm px-3 py-1.5 rounded">
            + New
          </button>
        </div>
      </div>

      {editor && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2">
          <input value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })}
                 placeholder="Policy name"
                 className="block w-full rounded border px-3 py-2 bg-transparent" />
          <textarea value={editor.spec} onChange={e => setEditor({ ...editor, spec: e.target.value })}
                    className="block w-full h-64 rounded border px-3 py-2 font-mono text-xs bg-transparent" />
          <div className="flex justify-end gap-2">
            <button onClick={() => setEditor(null)} className="px-3 py-1.5 text-sm">Cancel</button>
            <button onClick={() => save.mutate()}
                    className="bg-brand-600 hover:bg-brand-700 text-white text-sm px-3 py-1.5 rounded">
              {editor.id ? 'Save new version' : 'Save'}
            </button>
          </div>
        </div>
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
                    <button onClick={() => setEditor({ id: p.id, name: p.name, spec: JSON.stringify(p.spec, null, 2) })}
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
