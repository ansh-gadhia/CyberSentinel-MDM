import { api } from './client';

export interface Device {
  id: string;
  tenant_id: string;
  serial_number?: string;
  manufacturer?: string;
  model?: string;
  os_version?: string;
  security_patch_level?: string;
  state: 'pending' | 'enrolled' | 'offline' | 'wiped' | 'retired';
  last_heartbeat_at?: string;
  applied_policy_version: number;
}

export async function listDevices(params: { limit?: number; offset?: number; q?: string; state?: string }) {
  const r = await api.get<{ total: number; items: Device[] }>('/api/v1/devices', { params });
  return r.data;
}

export async function getDevice(id: string) {
  const r = await api.get<Device>(`/api/v1/devices/${id}`);
  return r.data;
}

export async function retireDevice(id: string) {
  await api.delete(`/api/v1/devices/${id}`);
}

export interface CommandRow {
  id: string;
  device_id: string;
  kind: string;
  state: string;
  attempts: number;
  created_at: string;
  completed_at?: string;
  last_error?: string;
  result?: Record<string, unknown> | null;
}

export async function listDeviceCommands(deviceID: string) {
  const r = await api.get<{ items: CommandRow[] }>(`/api/v1/commands/by-device/${deviceID}`);
  return r.data.items;
}

export async function issueCommand(deviceID: string, kind: string, payload: Record<string, unknown> = {}) {
  const r = await api.post('/api/v1/commands', { device_id: deviceID, kind, payload });
  return r.data as CommandRow;
}

export async function deviceTelemetryLatest(deviceID: string) {
  const r = await api.get(`/api/v1/telemetry/devices/${deviceID}/latest`);
  return r.data as Record<string, unknown>;
}
