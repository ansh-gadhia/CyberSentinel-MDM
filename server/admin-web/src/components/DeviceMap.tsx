import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Device } from '../api/devices';
import { isOnline } from './online';

// Leaflet is loaded via a CDN <script> in index.html — declare the global
// so TypeScript doesn't complain. We pin to the unpkg-hosted 1.9.4 build.
declare global { interface Window { L: any } }

/**
 * Interactive OpenStreetMap-tiled fleet map. Drops a marker for every
 * device that has a last_latitude / last_longitude reported via heartbeat.
 *
 *   - Online (heartbeat within 150s) → solid emerald dot
 *   - Stale / offline                → grey dot
 *   - Empty data                     → centered "no fixes yet" placeholder
 *
 * Clicking a marker opens a small popup with the device label and a deep
 * link into /devices/{id}. The map auto-fits to the visible markers on
 * first render; subsequent fleet updates do NOT re-pan so a refresh
 * doesn't yank the admin around while they're investigating one device.
 */
export function DeviceMap({ devices, height = 420 }: { devices: Device[]; height?: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const markerLayerRef = useRef<any>(null);
  const fittedRef = useRef<boolean>(false);

  const located = devices.filter(d => d.last_latitude != null && d.last_longitude != null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (typeof window.L === 'undefined') {
      // Leaflet not loaded yet (CDN slow / offline). Fall back to nothing —
      // the placeholder JSX below takes over via the `located.length === 0`
      // path on the next render. We can't easily wait for it here without
      // a polling effect, and in practice the script is cached after first hit.
      return;
    }
    if (!mapRef.current) {
      const map = window.L.map(containerRef.current, {
        center: [20.5937, 78.9629], // India centroid — overwritten by fitBounds
        zoom: 5,
        scrollWheelZoom: true,
        worldCopyJump: true
      });
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
      }).addTo(map);
      markerLayerRef.current = window.L.layerGroup().addTo(map);
      mapRef.current = map;
    }
    const map = mapRef.current;
    const layer = markerLayerRef.current;
    layer.clearLayers();
    const latlngs: [number, number][] = [];
    for (const d of located) {
      const lat = d.last_latitude as number;
      const lng = d.last_longitude as number;
      const online = isOnline(d.last_heartbeat_at);
      const color = online ? '#10b981' : '#94a3b8';
      const ring  = online ? 'rgba(16,185,129,0.35)' : 'rgba(148,163,184,0.30)';
      const icon = window.L.divIcon({
        className: '',
        html: `<span style="display:inline-block;width:14px;height:14px;border-radius:9999px;background:${color};box-shadow:0 0 0 6px ${ring};border:2px solid #fff"></span>`,
        iconSize: [14, 14], iconAnchor: [7, 7]
      });
      const label = d.model ? `${d.manufacturer ?? ''} ${d.model}`.trim() : (d.serial_number ?? d.id.slice(0, 8));
      const acc = d.last_location_accuracy_m != null ? `±${Math.round(d.last_location_accuracy_m)}m` : '';
      const seen = d.last_location_at ? new Date(d.last_location_at).toLocaleTimeString() : '';
      const html = `
        <div style="font-family:inherit;font-size:12px;line-height:1.4;">
          <div style="font-weight:600;">${escapeHtml(label)}</div>
          <div style="color:#64748b;">${lat.toFixed(5)}, ${lng.toFixed(5)} ${acc}</div>
          ${seen ? `<div style="color:#64748b;">fix @ ${seen}</div>` : ''}
          <a href="/devices/${d.id}" style="color:#0284c7;text-decoration:underline;">open device →</a>
        </div>`;
      const m = window.L.marker([lat, lng], { icon }).addTo(layer).bindPopup(html);
      latlngs.push([lat, lng]);
      m.on('click', () => m.openPopup());
    }
    if (latlngs.length > 0 && !fittedRef.current) {
      map.fitBounds(latlngs as any, { padding: [40, 40], maxZoom: 14 });
      fittedRef.current = true;
    }
    // Keep map sized to its container after Tailwind layout shifts.
    setTimeout(() => map.invalidateSize(), 0);
  }, [located.map(d => `${d.id}:${d.last_latitude},${d.last_longitude},${d.last_heartbeat_at}`).join('|')]);

  useEffect(() => () => {
    if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
  }, []);

  if (located.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
        <h2 className="font-medium mb-3">Fleet map</h2>
        <div className="flex items-center justify-center text-sm text-slate-500" style={{ height }}>
          No devices have reported a location yet — heartbeats refresh GPS every ~5&nbsp;min.
        </div>
      </div>
    );
  }

  const onlineCount = located.filter(d => isOnline(d.last_heartbeat_at)).length;
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-medium">Fleet map</h2>
        <div className="text-xs text-slate-500">
          {located.length} located · <span className="text-emerald-600 dark:text-emerald-400">{onlineCount} online</span>
          {' '}· <Link to="/devices" className="text-brand-600 hover:underline">device list →</Link>
        </div>
      </div>
      <div ref={containerRef} style={{ height, borderRadius: 8, overflow: 'hidden' }} />
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}
