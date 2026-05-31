import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRoles, listUsers, createUser, updateUserRole, deactivateUser } from '../api/auth';
import { useCan, assignableRoles, canManageTarget } from '../lib/rbac';
import { useAuth } from '../stores/authStore';
import { toast } from '../components/toast';

export function Roles() {
  const canViewMatrix = useCan('role:read');
  const canViewUsers = useCan('user:read');
  const canManage = useCan('user:manage');

  if (!canViewMatrix && !canViewUsers) {
    return <div className="text-sm text-slate-500">You don't have access to roles &amp; users.</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Access control</h1>
        <p className="text-sm text-slate-500">Roles, their permissions, and the users they're assigned to.</p>
      </div>
      {canViewUsers && <UsersSection canManage={canManage} />}
      {canViewMatrix && <MatrixSection />}
    </div>
  );
}

function UsersSection({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const myID = useAuth(s => s.user?.id);
  const myRole = useAuth(s => s.user?.role);
  const { data: users, isLoading } = useQuery({ queryKey: ['tenant-users'], queryFn: listUsers, refetchInterval: 10000 });
  const { data: matrix } = useQuery({ queryKey: ['roles-matrix'], queryFn: getRoles });
  const roles = matrix?.roles ?? ['viewer', 'operator', 'admin', 'super_admin'];
  // Only roles at or below my own — an admin can't mint/assign super_admin.
  const assignable = assignableRoles(myRole, roles);

  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [role, setRole] = useState('viewer');

  const create = useMutation({
    mutationFn: () => createUser(email.trim(), pw, role),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tenant-users'] }); setEmail(''); setPw(''); setRole('viewer'); toast.success('User created'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Create failed')
  });
  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) => updateUserRole(id, role),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tenant-users'] }); toast.success('Role updated'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Update failed')
  });
  const deactivate = useMutation({
    mutationFn: (id: string) => deactivateUser(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tenant-users'] }); toast.success('User deactivated'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Deactivate failed')
  });

  return (
    <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-4">
      <h2 className="font-medium">Users</h2>

      {canManage && (
        <div className="flex flex-wrap items-end gap-3 border-b border-slate-100 dark:border-slate-800 pb-4">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Email</label>
            <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="user@company.com"
                   className="text-sm rounded border bg-transparent px-2 py-1.5 w-56" />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Temp password (min 8)</label>
            <input value={pw} onChange={e => setPw(e.target.value)} type="text" placeholder="set a password"
                   className="text-sm rounded border bg-transparent px-2 py-1.5 w-48" />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Role</label>
            <select value={role} onChange={e => setRole(e.target.value)} className="text-sm rounded border bg-transparent px-2 py-1.5">
              {assignable.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <button disabled={!email.trim() || pw.length < 8 || create.isPending} onClick={() => create.mutate()}
                  className="text-sm px-3 py-1.5 rounded bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-40">
            Create user
          </button>
        </div>
      )}

      {isLoading && <div className="text-sm text-slate-500">Loading…</div>}
      <table className="w-full text-sm">
        <thead className="text-left text-slate-500">
          <tr>
            <th className="font-normal py-1">Email</th>
            <th className="font-normal py-1">Role</th>
            <th className="font-normal py-1 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users?.map(u => {
            const isSelf = u.id === myID;
            const manageable = canManage && !isSelf && canManageTarget(myRole, u.role);
            return (
              <tr key={u.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1.5">{u.email}{isSelf && <span className="ml-1 text-[10px] text-slate-400">(you)</span>}</td>
                <td className="py-1.5">
                  {manageable ? (
                    <select
                      value={u.role}
                      onChange={e => changeRole.mutate({ id: u.id, role: e.target.value })}
                      className="text-sm rounded border bg-transparent px-2 py-1">
                      {assignable.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  ) : (
                    <span className="capitalize">{u.role.replace('_', ' ')}</span>
                  )}
                </td>
                <td className="py-1.5 text-right">
                  {manageable ? (
                    <button onClick={() => { if (confirm(`Deactivate ${u.email}?`)) deactivate.mutate(u.id); }}
                            className="text-xs px-2 py-1 rounded border border-rose-300 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950">
                      Deactivate
                    </button>
                  ) : (
                    <span className="text-xs text-slate-400">
                      {isSelf ? 'current session' : canManage ? 'higher role — locked' : '—'}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function MatrixSection() {
  const { data } = useQuery({ queryKey: ['roles-matrix'], queryFn: getRoles });
  if (!data) return null;
  const held = (role: string, perm: string) => data.matrix[role]?.includes(perm);
  return (
    <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <h2 className="font-medium mb-1">Permission matrix</h2>
      <p className="text-xs text-slate-500 mb-3">Fixed roles. super_admin holds every permission. Enforced server-side on every request.</p>
      <div className="overflow-x-auto">
        <table className="text-sm border-collapse">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="font-normal py-1 pr-4 sticky left-0 bg-white dark:bg-slate-900">Permission</th>
              {data.roles.map(r => <th key={r} className="font-normal py-1 px-3 text-center whitespace-nowrap">{r}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.permissions.map(p => (
              <tr key={p} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1 pr-4 font-mono text-xs sticky left-0 bg-white dark:bg-slate-900">{p}</td>
                {data.roles.map(r => (
                  <td key={r} className="py-1 px-3 text-center">
                    {held(r, p)
                      ? <span className="text-emerald-600 dark:text-emerald-400">✓</span>
                      : <span className="text-slate-300 dark:text-slate-700">·</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
