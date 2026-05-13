import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { createEnrollmentToken, fetchQRPayload, EnrollmentToken } from '../api/enrollment';

export function Enrollment() {
  const [created, setCreated] = useState<EnrollmentToken | null>(null);
  const create = useMutation({
    mutationFn: () => createEnrollmentToken({ one_shot: false, max_uses: 50, expires_in: '24h' }),
    onSuccess: t => setCreated(t)
  });

  const { data: qrPayload } = useQuery({
    enabled: !!created,
    queryKey: ['qr', created?.id],
    queryFn: () => fetchQRPayload(created!.id)
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Enrollment</h1>
        <button onClick={() => create.mutate()} className="bg-brand-600 hover:bg-brand-700 text-white text-sm px-3 py-1.5 rounded">
          Generate new token
        </button>
      </div>

      {created && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-3">
          <div>
            <div className="text-xs uppercase text-slate-500">Token</div>
            <div className="font-mono text-sm break-all">{created.token}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-slate-500">Expires</div>
            <div>{new Date(created.expires_at).toLocaleString()}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-slate-500">Provision URL</div>
            <code className="text-xs break-all">{created.provision_url}</code>
          </div>
          {qrPayload && (
            <div>
              <div className="text-xs uppercase text-slate-500 mt-3">QR JSON Payload</div>
              <pre className="text-xs bg-slate-50 dark:bg-slate-950 rounded p-3 overflow-auto">{JSON.stringify(qrPayload, null, 2)}</pre>
              <p className="text-xs text-slate-500 mt-2">Encode this JSON into a QR code (any QR generator). Scan from the Android Setup Wizard's six-tap welcome screen.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
