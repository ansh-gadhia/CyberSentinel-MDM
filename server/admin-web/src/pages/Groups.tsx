import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listGroups, createGroup, updateGroup, deleteGroup, type DeviceGroup } from '../api/groups';
import { listPolicies, listAssignmentsFor, assignPolicy, unassignPolicy } from '../api/policies';
import { broadcastCommand } from '../api/devices';
import { useCan } from '../lib/rbac';
import { toast } from '../components/toast';

export function Groups() {
  const qc = useQueryClient();
  const canEdit = useCan('group:manage');
  const canAssign = useCan('policy:assign');
  const canMessage = useCan('command:issue:basic');

  const { data: groups, isLoading } = useQuery({ queryKey: ['groups'], queryFn: listGroups, refetchInterval: 8000 });
  const { data: policies } = useQuery({ queryKey: ['policies'], queryFn: listPolicies });

  // Fetch every policy's assignments once, then index group_id → [policies] so
  // each group card can show (and unassign) the policies targeting it.
  const policyIDs = (policies ?? []).map(p => p.id);
  const { data: assignments } = useQuery({
    queryKey: ['all-policy-assignments', policyIDs],
    enabled: policyIDs.length > 0,
    refetchInterval: 8000,
    queryFn: async () => {
      const rows = await Promise.all(policyIDs.map(id => listAssignmentsFor(id).then(items => ({ id, items }))));
      return rows;
    }
  });
  const policyName = useMemo(() => new Map((policies ?? []).map(p => [p.id, `${p.name} (v${p.version})`])), [policies]);
  const groupPolicies = useMemo(() => {
    const m = new Map<string, { policyID: string }[]>();
    (assignments ?? []).forEach(({ id, items }) => {
      items.filter(a => a.target_kind === 'group' && a.target_id).forEach(a => {
        const arr = m.get(a.target_id!) ?? [];
        arr.push({ policyID: id });
        m.set(a.target_id!, arr);
      });
    });
    return m;
  }, [assignments]);

  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');

  const create = useMutation({
    mutationFn: () => createGroup(name.trim(), desc.trim()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['groups'] }); setName(''); setDesc(''); toast.success('Group created'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Create failed')
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteGroup(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['groups'] }); toast.success('Group deleted'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Delete failed')
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Groups</h1>
          <p className="text-sm text-slate-500">Classify devices (e.g. Employees, Interns). A policy assigned to a group applies to every device in it.</p>
        </div>
      </div>

      {canEdit && (
        <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <h2 className="font-medium mb-3">Create a group</h2>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs text-slate-500 mb-1">Name</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Employees"
                     className="text-sm rounded border bg-transparent px-2 py-1.5 w-48" />
            </div>
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs text-slate-500 mb-1">Description (optional)</label>
              <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Full-time staff devices"
                     className="text-sm rounded border bg-transparent px-2 py-1.5 w-full" />
            </div>
            <button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}
                    className="text-sm px-3 py-1.5 rounded bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-40">
              Create group
            </button>
          </div>
        </section>
      )}

      {isLoading && <div className="text-sm text-slate-500">Loading…</div>}
      {!isLoading && groups?.length === 0 && (
        <div className="text-center py-10 text-slate-500 text-sm border border-dashed border-slate-200 dark:border-slate-700 rounded-lg">
          No groups yet.{canEdit ? ' Create one above.' : ''}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {groups?.map(g => (
          <GroupCard
            key={g.id}
            group={g}
            canEdit={canEdit}
            canAssign={canAssign}
            canMessage={canMessage}
            policyOptions={(policies ?? []).map(p => ({ id: p.id, label: `${p.name} (v${p.version})` }))}
            assignedPolicies={(groupPolicies.get(g.id) ?? []).map(x => ({ id: x.policyID, label: policyName.get(x.policyID) ?? x.policyID.slice(0, 8) }))}
            onDelete={() => { if (confirm(`Delete group "${g.name}"? Devices in it will fall back to tenant-level policy.`)) remove.mutate(g.id); }}
          />
        ))}
      </div>
    </div>
  );
}

function GroupCard({ group, canEdit, canAssign, canMessage, policyOptions, assignedPolicies, onDelete }: {
  group: DeviceGroup;
  canEdit: boolean;
  canAssign: boolean;
  canMessage: boolean;
  policyOptions: { id: string; label: string }[];
  assignedPolicies: { id: string; label: string }[];
  onDelete: () => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const [desc, setDesc] = useState(group.description ?? '');
  const [pick, setPick] = useState('');
  const [msgOpen, setMsgOpen] = useState(false);
  const [msgTitle, setMsgTitle] = useState('Message from IT');
  const [msgBody, setMsgBody] = useState('');

  const broadcast = useMutation({
    mutationFn: () => broadcastCommand(group.id, 'SHOW_MESSAGE', { title: msgTitle.trim() || 'Message', message: msgBody.trim() }),
    onSuccess: (n) => { setMsgOpen(false); setMsgBody(''); toast.success(`Message sent to ${n} device${n === 1 ? '' : 's'}`); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Send failed')
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['groups'] });
    qc.invalidateQueries({ queryKey: ['all-policy-assignments'] });
  };
  const save = useMutation({
    mutationFn: () => updateGroup(group.id, { name: name.trim(), description: desc.trim() }),
    onSuccess: () => { invalidate(); setEditing(false); toast.success('Group updated'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Update failed')
  });
  const assign = useMutation({
    mutationFn: (policyID: string) => assignPolicy(policyID, 'group', group.id),
    onSuccess: () => { invalidate(); setPick(''); toast.success('Policy assigned to group — devices will reconcile'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Assign failed')
  });
  const unassign = useMutation({
    mutationFn: (policyID: string) => unassignPolicy(policyID, 'group', group.id),
    onSuccess: () => { invalidate(); toast.success('Policy unassigned'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Unassign failed')
  });

  const assignedIDs = new Set(assignedPolicies.map(p => p.id));
  const available = policyOptions.filter(p => !assignedIDs.has(p.id));

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
      {!editing ? (
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-medium">{group.name}</div>
            {group.description && <div className="text-xs text-slate-500">{group.description}</div>}
            <div className="text-xs text-slate-400 mt-0.5">{group.device_count} device{group.device_count === 1 ? '' : 's'}</div>
          </div>
          <div className="flex gap-2 shrink-0">
            {canMessage && (
              <button onClick={() => { setMsgTitle('Message from IT'); setMsgOpen(true); }}
                      className="text-xs px-2 py-1 rounded border hover:bg-slate-50 dark:hover:bg-slate-800">Message</button>
            )}
            {canEdit && (
              <>
                <button onClick={() => { setName(group.name); setDesc(group.description ?? ''); setEditing(true); }}
                        className="text-xs px-2 py-1 rounded border hover:bg-slate-50 dark:hover:bg-slate-800">Edit</button>
                <button onClick={onDelete}
                        className="text-xs px-2 py-1 rounded border border-rose-300 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950">Delete</button>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <input value={name} onChange={e => setName(e.target.value)} className="text-sm rounded border bg-transparent px-2 py-1.5 w-full" placeholder="Group name" />
          <input value={desc} onChange={e => setDesc(e.target.value)} className="text-sm rounded border bg-transparent px-2 py-1.5 w-full" placeholder="Description" />
          <div className="flex gap-2">
            <button disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}
                    className="text-xs px-3 py-1 rounded bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-40">Save</button>
            <button onClick={() => setEditing(false)} className="text-xs px-3 py-1 rounded border">Cancel</button>
          </div>
        </div>
      )}

      <div className="border-t border-slate-100 dark:border-slate-800 pt-2">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1.5">Policies on this group</div>
        {assignedPolicies.length === 0 ? (
          <div className="text-xs text-slate-400">None assigned.</div>
        ) : (
          <ul className="space-y-1">
            {assignedPolicies.map(p => (
              <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{p.label}</span>
                {canAssign && (
                  <button onClick={() => unassign.mutate(p.id)} disabled={unassign.isPending}
                          className="text-xs text-rose-600 hover:underline shrink-0">remove</button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canAssign && available.length > 0 && (
          <div className="flex items-center gap-2 mt-2">
            <select value={pick} onChange={e => setPick(e.target.value)} className="text-sm rounded border bg-transparent px-2 py-1 flex-1">
              <option value="">Assign a policy…</option>
              {available.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <button disabled={!pick || assign.isPending} onClick={() => assign.mutate(pick)}
                    className="text-xs px-3 py-1.5 rounded bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-40">Assign</button>
          </div>
        )}
      </div>

      {msgOpen && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setMsgOpen(false)}>
          <div onClick={e => e.stopPropagation()}
               className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 w-[440px] space-y-3 shadow-xl">
            <div className="font-medium">Message everyone in “{group.name}”</div>
            <div className="text-xs text-slate-500">{group.device_count} device{group.device_count === 1 ? '' : 's'} will receive a pop-up.</div>
            <input value={msgTitle} onChange={e => setMsgTitle(e.target.value)} placeholder="Title"
                   className="block w-full rounded border bg-transparent px-3 py-2 text-sm" />
            <textarea value={msgBody} onChange={e => setMsgBody(e.target.value)} placeholder="Message…" rows={4}
                      className="block w-full rounded border bg-transparent px-3 py-2 text-sm" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setMsgOpen(false)} className="text-sm px-3 py-1.5">Cancel</button>
              <button disabled={!msgBody.trim() || broadcast.isPending} onClick={() => broadcast.mutate()}
                      className="text-sm px-3 py-1.5 rounded bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-40">
                {broadcast.isPending ? 'Sending…' : 'Send to group'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
