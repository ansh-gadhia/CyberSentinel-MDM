import { api } from './client';

export interface Policy {
  id: string;
  name: string;
  version: number;
  spec: Record<string, unknown>;
  updated_at: string;
}

export async function listPolicies() {
  const r = await api.get<{ items: Policy[] }>('/api/v1/policies');
  return r.data.items;
}

export async function savePolicy(p: { id?: string; name: string; spec: Record<string, unknown> }) {
  const r = await api.post<Policy>('/api/v1/policies', p);
  return r.data;
}

export async function assignPolicy(policy_id: string, target_kind: 'tenant' | 'group' | 'device', target_id?: string) {
  await api.post('/api/v1/policies/assign', { policy_id, target_kind, target_id });
}
