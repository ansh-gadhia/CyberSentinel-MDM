import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listPolicies, savePolicy } from '../api/policies';
import { useState } from 'react';

export function Policies() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['policies'], queryFn: listPolicies });
  const [editor, setEditor] = useState<{ name: string; spec: string } | null>(null);

  const save = useMutation({
    mutationFn: () => {
      if (!editor) throw new Error('no editor');
      const spec = JSON.parse(editor.spec);
      return savePolicy({ name: editor.name, spec });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['policies'] }); setEditor(null); }
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Policies</h1>
        <button onClick={() => setEditor({ name: '', spec: '{\n  "version": 1\n}' })}
                className="bg-brand-600 hover:bg-brand-700 text-white text-sm px-3 py-1.5 rounded">+ New</button>
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
            <button onClick={() => save.mutate()} className="bg-brand-600 hover:bg-brand-700 text-white text-sm px-3 py-1.5 rounded">Save</button>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800 text-left">
            <tr><th className="px-4 py-2">Name</th><th className="px-4 py-2">Version</th><th className="px-4 py-2">Updated</th></tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={3} className="px-4 py-6 text-center text-slate-500">loading…</td></tr>}
            {data?.map(p => (
              <tr key={p.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2">{p.name}</td>
                <td className="px-4 py-2">v{p.version}</td>
                <td className="px-4 py-2">{new Date(p.updated_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
