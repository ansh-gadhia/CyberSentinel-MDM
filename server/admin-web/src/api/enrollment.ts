import { api } from './client';

export interface EnrollmentToken {
  id: string;
  token: string;
  expires_at: string;
  qr_url: string;
  provision_url: string;
}

export async function createEnrollmentToken(input: { one_shot: boolean; max_uses: number; expires_in: string; policy_id?: string }) {
  const r = await api.post<EnrollmentToken>('/api/v1/enroll/tokens', input);
  return r.data;
}

export async function fetchQRPayload(tokenID: string) {
  const r = await api.get(`/api/v1/enroll/qr/${tokenID}`);
  return r.data;
}
