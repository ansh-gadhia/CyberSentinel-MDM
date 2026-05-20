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
  assigned_policy_id?: string | null;
  last_latitude?: number | null;
  last_longitude?: number | null;
  last_location_accuracy_m?: number | null;
  last_location_at?: string | null;
  last_ip_address?: string | null;
  last_mac_address?: string | null;
  last_battery_pct?: number | null;
  last_charging?: boolean | null;
  last_vpn_active?: boolean | null;
  last_storage_free_bytes?: number | null;
  last_wifi_ssid?: string | null;
  last_network_type?: string | null;
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

export interface ActivityEvent {
  id: string;
  device_id: string;
  kind: string;
  payload: Record<string, unknown>;
  captured_at: string;
  received_at: string;
}

export async function listDeviceEvents(deviceID: string, kindPrefix = 'activity.', limit = 200) {
  const r = await api.get<{ items: ActivityEvent[] }>(
    `/api/v1/telemetry/devices/${deviceID}/events`,
    { params: { limit, kind_prefix: kindPrefix } }
  );
  return r.data.items;
}

// latestResultByKind walks the recent command history and returns the most
// recent successful result for the given kind, or null if none.
export function latestResultByKind(rows: CommandRow[] | undefined, kind: string): Record<string, unknown> | null {
  if (!rows) return null;
  for (const c of rows) {
    if (c.kind === kind && c.state === 'succeeded' && c.result) return c.result;
  }
  return null;
}
