import { api } from './client';

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: { id: string; email: string; role: string; tenant_id: string };
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  const r = await api.post<LoginResponse>('/api/v1/auth/login', { email, password });
  return r.data;
}

export async function me() {
  const r = await api.get('/api/v1/auth/me');
  return r.data as { id: string; email: string; role: string; tenant_id: string };
}

export async function logoutServer(refresh_token: string) {
  await api.post('/api/v1/auth/logout', { refresh_token });
}
