import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listFiles, uploadFile, type FileObject } from '../api/files';
import { listDevices, issueCommand } from '../api/devices';

export function Apps() {
  const qc = useQueryClient();
  const { data: files, isLoading } = useQuery({
    queryKey: ['files', 'apk'],
    queryFn: () => listFiles('apk')
  });

  const [busy, setBusy] = useState(false);
  const [installFor, setInstallFor] = useState<FileObject | null>(null);

  const upload = useMutation({
    mutationFn: (f: File) => uploadFile(f, 'apk'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files', 'apk'] }),
    onSettled: () => setBusy(false)
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Apps</h1>
        <label className="inline-flex items-center gap-2 rounded bg-brand-600 hover:bg-brand-700 text-white text-sm px-3 py-1.5 cursor-pointer">
          {busy ? 'Uploading…' : 'Upload APK'}
          <input type="file" accept=".apk,application/vnd.android.package-archive" className="hidden"
                 disabled={busy}
                 onChange={e => {
                   const f = e.target.files?.[0];
                   if (f) { setBusy(true); upload.mutate(f); e.currentTarget.value = ''; }
                 }} />
        </label>
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800 text-left text-slate-500">
            <tr>
              <th className="px-4 py-2 font-normal">Name</th>
              <th className="px-4 py-2 font-normal">Size</th>
              <th className="px-4 py-2 font-normal">SHA-256</th>
              <th className="px-4 py-2 font-normal">Uploaded</th>
              <th className="px-4 py-2 font-normal text-right"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-400">loading…</td></tr>}
            {!isLoading && files?.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">No APKs uploaded yet.</td></tr>
            )}
            {files?.map(f => (
              <tr key={f.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2">{f.name}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{formatSize(f.size_bytes)}</td>
                <td className="px-4 py-2 font-mono text-[11px] text-slate-500" title={f.sha256}>{f.sha256.slice(0, 16)}…</td>
                <td className="px-4 py-2 text-xs text-slate-500">{new Date(f.created_at).toLocaleString()}</td>
                <td className="px-4 py-2 text-right">
                  <button onClick={() => setInstallFor(f)}
                          className="text-xs px-2 py-1 rounded border hover:bg-slate-50 dark:hover:bg-slate-800">
                    Install to device…
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {installFor && <InstallToDeviceModal file={installFor} onClose={() => setInstallFor(null)} />}
    </div>
  );
}

function formatSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function InstallToDeviceModal({ file, onClose }: { file: FileObject; onClose: () => void }) {
  const [pkg, setPkg] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { data, isLoading } = useQuery({
    queryKey: ['devices', 'install-target'],
    queryFn: () => listDevices({ limit: 200, state: 'enrolled' })
  });

  const fire = useMutation({
    mutationFn: async () => {
      const ids = Array.from(selected);
      for (const id of ids) {
        await issueCommand(id, 'INSTALL_APP', {
          // Empty package_name → agent lets PackageInstaller derive it from the APK.
          ...(pkg ? { package_name: pkg } : {}),
          download_object_id: file.id
        });
      }
    },
    onSuccess: onClose
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 w-[520px] max-h-[80vh] overflow-auto space-y-3 shadow-xl">
        <div className="font-medium">Install <span className="font-mono text-sm">{file.name}</span></div>
        <p className="text-xs text-slate-500">
          Pick one or more enrolled devices. Silent install requires Device Owner; in Device Admin mode
          the user will be prompted on the device.
        </p>
        <label className="block">
          <span className="text-xs text-slate-500">Package name (optional — leave blank to auto-detect from the APK)</span>
          <input value={pkg} onChange={e => setPkg(e.target.value)} placeholder="auto"
                 className="block w-full rounded border bg-transparent px-3 py-2 text-sm mt-1" /></label>
        <div className="border border-slate-200 dark:border-slate-800 rounded max-h-72 overflow-auto">
          {isLoading && <div className="p-3 text-sm text-slate-500">loading devices…</div>}
          {data?.items.map(d => (
            <label key={d.id} className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-b-0">
              <input
                type="checkbox"
                checked={selected.has(d.id)}
                onChange={e => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(d.id); else next.delete(d.id);
                  setSelected(next);
                }} />
              <span className="text-sm">{d.manufacturer} {d.model}</span>
              <span className="text-xs text-slate-500 font-mono ml-auto">{d.serial_number ?? d.id.slice(0, 8)}</span>
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="text-sm px-3 py-1.5">Cancel</button>
          <button onClick={() => fire.mutate()} disabled={selected.size === 0}
                  className="text-sm px-3 py-1.5 rounded bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-40">
            Send INSTALL_APP to {selected.size} device{selected.size === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}
