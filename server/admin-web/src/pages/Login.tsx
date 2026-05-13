import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login } from '../api/auth';
import { useAuth } from '../stores/authStore';

export function Login() {
  const [email, setEmail] = useState('admin@mdm.local');
  const [password, setPassword] = useState('ChangeMe!123');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const setTokens = useAuth(s => s.setTokens);
  const setUser = useAuth(s => s.setUser);
  const navigate = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await login(email, password);
      setTokens(r.access_token, r.refresh_token);
      setUser(r.user);
      navigate('/');
    } catch (e: any) {
      setErr(e?.response?.data?.error ?? 'login failed');
    } finally { setBusy(false); }
  };

  return (
    <div className="flex h-full items-center justify-center">
      <form onSubmit={submit}
            className="bg-white dark:bg-slate-900 shadow rounded-lg p-8 w-96 space-y-4 border border-slate-200 dark:border-slate-800">
        <div className="mb-2">
          <h1 className="text-xl font-semibold">CyberSentinel MDM</h1>
          <p className="text-xs text-slate-500">Virtual Galaxy Infotech Ltd</p>
        </div>
        <h2 className="text-sm font-medium text-slate-600 dark:text-slate-300">Sign in to continue</h2>
        <div>
          <label className="block text-sm mb-1">Email</label>
          <input className="w-full rounded border px-3 py-2 bg-transparent" autoFocus
                 value={email} onChange={e => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="block text-sm mb-1">Password</label>
          <input type="password" className="w-full rounded border px-3 py-2 bg-transparent"
                 value={password} onChange={e => setPassword(e.target.value)} />
        </div>
        {err && <div className="text-sm text-red-600">{err}</div>}
        <button disabled={busy}
                className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white rounded py-2">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
