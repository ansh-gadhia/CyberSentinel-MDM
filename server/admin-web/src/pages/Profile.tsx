import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { changePassword, updateEmail } from '../api/auth';
import { useAuth } from '../stores/authStore';
import { toast } from '../components/toast';

export function Profile() {
  const { user, setUser, dark, toggleDark, logout } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState(user?.email ?? '');
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');

  const saveEmail = useMutation({
    mutationFn: () => updateEmail(email.trim()),
    onSuccess: (u) => { setUser(u); toast.success('Email updated'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Update failed')
  });

  const savePw = useMutation({
    mutationFn: () => changePassword(oldPw, newPw),
    onSuccess: () => {
      setOldPw(''); setNewPw(''); setConfirmPw('');
      toast.success('Password changed');
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Change failed')
  });

  const pwMismatch = newPw.length > 0 && confirmPw.length > 0 && newPw !== confirmPw;
  const canSavePw = oldPw.length > 0 && newPw.length >= 8 && newPw === confirmPw;

  return (
    <div className="max-w-2xl space-y-5">
      <h1 className="text-2xl font-semibold">Profile</h1>

      {/* Account */}
      <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
        <h2 className="font-medium">Account</h2>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-xs text-slate-500">Role</div>
            <div className="font-medium capitalize">{user?.role?.replace('_', ' ') ?? '—'}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Tenant</div>
            <div className="font-mono text-xs">{user?.tenant_id ?? '—'}</div>
          </div>
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Email</label>
          <div className="flex gap-2">
            <input value={email} onChange={e => setEmail(e.target.value)} type="email"
                   className="text-sm rounded border bg-transparent px-3 py-2 flex-1" />
            <button
              disabled={!email.trim() || email.trim() === user?.email || saveEmail.isPending}
              onClick={() => saveEmail.mutate()}
              className="text-sm px-3 py-2 rounded bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-40">
              Save
            </button>
          </div>
        </div>
      </section>

      {/* Password */}
      <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
        <h2 className="font-medium">Change password</h2>
        <div className="space-y-2">
          <input type="password" value={oldPw} onChange={e => setOldPw(e.target.value)} placeholder="Current password"
                 className="text-sm rounded border bg-transparent px-3 py-2 w-full" />
          <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} placeholder="New password (min 8 chars)"
                 className="text-sm rounded border bg-transparent px-3 py-2 w-full" />
          <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} placeholder="Confirm new password"
                 className="text-sm rounded border bg-transparent px-3 py-2 w-full" />
          {pwMismatch && <div className="text-xs text-rose-600">Passwords don't match.</div>}
          {newPw.length > 0 && newPw.length < 8 && <div className="text-xs text-amber-600">New password must be at least 8 characters.</div>}
        </div>
        <button disabled={!canSavePw || savePw.isPending} onClick={() => savePw.mutate()}
                className="text-sm px-3 py-2 rounded bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-40">
          {savePw.isPending ? 'Saving…' : 'Change password'}
        </button>
      </section>

      {/* Preferences */}
      <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
        <h2 className="font-medium">Preferences</h2>
        <div className="flex items-center justify-between">
          <div className="text-sm">Theme</div>
          <button onClick={toggleDark} className="text-sm px-3 py-1.5 rounded border hover:bg-slate-50 dark:hover:bg-slate-800">
            {dark ? 'Switch to light' : 'Switch to dark'}
          </button>
        </div>
        <div className="flex items-center justify-between border-t border-slate-100 dark:border-slate-800 pt-3">
          <div className="text-sm">Session</div>
          <button onClick={() => { logout(); navigate('/login'); }}
                  className="text-sm px-3 py-1.5 rounded border border-rose-300 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950">
            Sign out
          </button>
        </div>
      </section>
    </div>
  );
}
