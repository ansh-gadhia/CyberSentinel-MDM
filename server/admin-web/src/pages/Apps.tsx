import { useState } from 'react';
import { api } from '../api/client';

export function Apps() {
  const [files, setFiles] = useState<{ name: string; sha256: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const upload = async (f: File) => {
    setBusy(true);
    const fd = new FormData();
    fd.append('file', f);
    fd.append('kind', 'apk');
    const r = await api.post('/api/v1/files/upload', fd);
    setFiles(prev => [...prev, r.data]);
    setBusy(false);
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Apps</h1>
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
        <label className="block">
          <span className="text-sm">Upload APK</span>
          <input
            type="file"
            accept=".apk,application/vnd.android.package-archive"
            disabled={busy}
            onChange={e => e.target.files?.[0] && upload(e.target.files[0])}
            className="block mt-2"
          />
        </label>
      </div>
      <table className="w-full text-sm">
        <thead><tr><th className="text-left p-2">Name</th><th className="text-left p-2">SHA-256</th></tr></thead>
        <tbody>{files.map((f, i) => <tr key={i} className="border-t"><td className="p-2">{f.name}</td><td className="p-2 font-mono text-xs">{f.sha256}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
