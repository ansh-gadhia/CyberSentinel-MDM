# CyberSentinel MDM

**Product:** CyberSentinel MDM
**Vendor:** Virtual Galaxy Infotech Ltd

Production-grade Android MDM platform inspired by Intune / SOTI / Workspace ONE. Multi-tenant ready, container-native, scalable to thousands of concurrent devices.

Runs in **three management modes**, all reported live and reflected in the UI:

| Mode | How | Capability |
|------|-----|------------|
| **Device Owner** | QR provisioning / `adb dpm set-device-owner` | Full control — silent install, restrictions, VPN/proxy, certs, auto-granted camera/mic/location |
| **Device Admin** | `adb dpm set-active-admin` | Lock, wipe, password policy, disable-camera; no silent app mgmt / restrictions |
| **Enrolled-only** | install + enroll, no admin role | Read-only telemetry + heartbeat + (user-granted) capture; no enforcement |

The agent reports its current mode on every heartbeat, so promotions (none → admin → owner) surface in the dashboard within a minute, the per-device capability matrix updates, and remote-action buttons enable/disable accordingly.

```
/server          Go microservices + React admin web
/android-agent   Kotlin/Compose Android Enterprise agent (Device Owner)
```

## Stack at a glance

| Layer            | Tech                                                          |
|------------------|---------------------------------------------------------------|
| Backend services | Go 1.22, Fiber v2, sqlx                                       |
| Database         | PostgreSQL 16 (multi-tenant via row-level `tenant_id`)        |
| Cache / sessions | Redis 7                                                       |
| Event bus        | NATS JetStream                                                |
| Realtime push    | MQTT (Eclipse Mosquitto) — QoS 1, cleanSession=false          |
| Object storage   | MinIO (S3 compatible) with per-request presigned URLs         |
| API gateway      | nginx (dev) with `resolver` for upstream re-resolution        |
| Observability    | Prometheus + Grafana + structured zerolog                     |
| Admin UI         | React 18, TypeScript, Vite, Tailwind, TanStack Query, Leaflet |
| Mobile agent     | Kotlin, Jetpack Compose, Hilt, WorkManager, Retrofit, paho    |
| Deployment       | Docker Compose (dev), Kubernetes manifests (prod)             |

## Capabilities

### Device management
- Android Enterprise **Device Owner** provisioning (QR / DPC identifier / ADB), plus Device Admin and enrolled-only modes
- Live heartbeats every 60 s (carrying battery/network/storage/location **and the current management mode**) + Doze-resistant alarm chain (`KeepAliveAlarm`)
- Real-time MQTT command channel + HTTP poll fallback
- 30+ command kinds: lock, wipe, reboot, install/uninstall, hide/show app, block/allow uninstall, clear app data, capture photo, **live audio capture** (`START/STOP_AUDIO_STREAM`), **on-screen message** (`SHOW_MESSAGE`), get location, set restrictions, reset password (via DO reset-password token machinery), set always-on VPN, set global proxy, install/remove CA cert, etc.
- **Device aliases** — operator-set friendly names (e.g. "Reception iPad"), editable by admin+, shown everywhere a device is referenced and searchable
- **Group broadcast** — fan any command (e.g. a message) out to every device in a group in one call (`POST /api/v1/commands/broadcast`)

### Policy engine
- **Multi-policy assignments**: tenant + group + device-level assignments layer onto a single device. The server deep-merges all bound policies into one effective spec (objects merge, arrays union, scalars override by precedence).
- **Automatic rollback on unassign**: removing a policy fires `APPLY_POLICY` to devices still bound elsewhere (re-merge) or `CLEAR_POLICY` to devices now bare (full rollback of camera, restrictions, blocklists, surveillance).
- **Diff-based reset**: the agent persists the last-applied spec and on every new apply resets any field that disappeared — so unassigning a "disable camera" policy actually re-enables the camera instead of leaving the phone stranded.
- Versioned policy documents (every edit = `version + 1`), JSON Merge Patch (RFC 7396) for audit.

### Restrictions, blocklists, surveillance
- All standard DPM user restrictions (USB transfer, Bluetooth, NFC, hotspot, location, accessibility, factory reset, safe boot, etc.)
- **App blocklist** — packages get `setApplicationHidden(true)` + `setUninstallBlocked(true)` per the policy spec; reconciled on every apply so removed entries get re-shown.
- **URL blocklist** — pushed as Chromium enterprise URLBlocklist via `setApplicationRestrictions` to Chrome / Edge / Brave / Chromium (e.g. block `*://*.youtube.com/*` system-wide).
- **Capture photo on every unlock** — `security.capture_on_unlock` policy snaps the front camera on every `USER_PRESENT` (lift/restore the camera-disable flag around the capture so this works even when camera is policy-disabled for the user).

### SIEM-style activity log
The agent ships every observable system event back to the server as a `TelemetryEvent`. The admin's per-device **Activity** tab reads it back in reverse chronological order:

- `activity.screen.on` / `activity.screen.off`
- `activity.user.present` (every unlock)
- `activity.power.connected` / `activity.power.disconnected`
- `activity.network.change` (with current transport + VPN + link kbps)
- `activity.package.added` / `.removed` / `.replaced`
- `activity.boot`
- `activity.app.foreground` (every 3 s via `UsageStatsManager`) — package + label of whatever the user opens
- `activity.location` (every 60 s GPS fix)
- `activity.unlock_photo` (with `file_id` of the front-camera shot)
- `activity.permission.needed` / `activity.permission.granted`
- `activity.monitor.started` (startup beacon)

### RBAC (role-based access control)
- Single source of truth: `shared/authz` — a fixed permission matrix (22 permissions) mapped to four roles: **viewer < operator < admin < super_admin** (`super_admin` = wildcard, fail-closed).
- `RequirePermission(...)` middleware on **every** admin route across all services (replaced ad-hoc role lists). Reads are open to any role with `*:read`; mutations need specific permissions. Denials are logged.
- **Per-command-kind risk tiers** enforced server-side: `command:issue:basic` (lock/locate/ring/inventory/**message**), `command:issue:privileged` (wipe/reset/install/restrictions/certs), `command:issue:surveillance` (camera photo / mic audio). An operator can lock or message a device but cannot wipe it or start a covert capture.
- **User & role management** (admin + super_admin) with a **no-escalation hierarchy** — you can only create/assign/modify users at or below your own rank, so an admin can't mint or touch a super_admin. Self-lockout and last-super_admin guards. All changes audited.
- **Access** page renders the live permission matrix and the user list; the UI gates nav and buttons by the caller's permissions (mirrors the server, which remains the authority).

### Device groups
- Create/edit/delete tenant-scoped groups ("Employees", "Interns") in the **Groups** page; assign a device to a group from its detail page.
- A policy assigned to a group applies to every member device and merges into its effective policy — visible in the device's Policy tab. Group-policy assignment + unassignment is managed from the Groups page.

### Live audio capture (near-live) + session stitching
- `START_AUDIO_STREAM` records the mic in short **AAC/ADTS** segments uploaded continuously; `STOP_AUDIO_STREAM` ends the session. The admin's **Audio** tab plays the feed ~5–8 s behind real time and archives every segment.
- Because ADTS segments concatenate by byte-append, the server **stitches a whole session into one continuous, scrubbable `.aac`** on demand (cached) — `GET /api/v1/files/audio/session/{id}/url` — so a recording plays as a single file. Whole-session delete (`DELETE …/audio/session/{id}`) removes all segments + the stitched cache; per-segment delete invalidates the cache.

### Messaging
- **Send a message to a device** (`SHOW_MESSAGE`) → pops up on the device screen as a dialog (show-when-locked) **and** a high-priority full-screen-intent notification, so it surfaces in any management mode.
- **Message a whole group** via the group broadcast endpoint.

### Admin web
- **Dashboard** with interactive Leaflet map of all live devices + recent audit (resolves actor → email, target → device name)
- Per-device **Overview / Policy / Apps / Photos & Location / Audio / Activity / Commands** tabs, with a **management-mode badge + capability matrix** and remote-action buttons gated by both device mode and the operator's permissions
- **Groups** page (group CRUD, device counts, group-policy assignment, group messaging) and **Access** page (permission matrix + user/role management)
- **Profile** page (change own email/password, theme); login no longer pre-fills seeded credentials
- **Policy tab** with layered-assignment view (device > group > tenant precedence badges) and per-row unassign-with-rollback
- Policies page with one-click templates: *Block YouTube (app + Chrome URLs)*, *Block social media*, *Capture front photo on every unlock*

## Quick start (local)

```bash
cd server
cp .env.example .env             # adjust as needed
docker compose up -d
# wait ~30 s for migrations
docker compose logs -f auth-service device-service command-service
```

Admin UI: <http://localhost/> (admin nginx; serves React + reverse-proxies API)
Default seeded admin: `admin@mdm.local` / `ChangeMe!123`
Grafana: <http://localhost:3001> (admin / admin)
MinIO console: <http://localhost:9001> (minioadmin / minioadmin)

### Cross-network photo URLs

Presigned MinIO URLs are signed against whatever host the **admin browser** is currently hitting (taken from `X-Forwarded-Host` set by the admin nginx; falls back to `MINIO_PUBLIC_ENDPOINT` for direct curl). This means a laptop on the office LAN, a phone on cellular, and a remote VPN client all get URLs that resolve on **their** network — no static reconfiguration needed.

## Enrolling a device

1. In admin UI, **Enrollment → Generate token**. This produces a QR provisioning payload that includes:
   - the DPC package + signature checksum
   - download URL of the signed agent APK
   - a one-time enrollment JWT and the tenant slug
2. Factory-reset Android device → tap the welcome screen 6 times → scan the QR.
3. Android installs the DPC, sets it as Device Owner, and the agent registers itself with the backend.

For ADB provisioning (development):

```bash
adb install -r android-agent/app/build/outputs/apk/debug/app-debug.apk
adb shell dpm set-device-owner com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver
```

The agent works **without** an admin role too: install + enroll alone gives "enrolled-only" mode (read-only telemetry + heartbeat; capture works only for permissions the user grants). Promote to Device Admin (`set-active-admin`) or Device Owner (`set-device-owner`) any time — the new mode is reported on the next heartbeat. The agent's home screen has a **Permissions panel** to grant camera/mic/location and the **Usage Access** special-access permission (`PACKAGE_USAGE_STATS` — signature-protected, so even a Device Owner can't grant it programmatically; one tap enables per-app foreground tracking).

> **Migrations** apply automatically only on a fresh Postgres volume. On an existing DB, apply new ones by hand, e.g. `docker compose exec -T postgres psql -U mdm -d mdm < infra/migrations/018_files_audio_kind.sql`. Migrations added recently: `016_device_alias`, `017_device_mgmt_mode`, `018_files_audio_kind`.

## Service topology

```
                  ┌──────────────────────────────┐
                  │     nginx (admin gateway)    │
                  └───────────┬──────────────────┘
                              │  REST + WS + presigned-URL passthrough
   ┌──────────────┬───────────┼────────────┬──────────────┬──────────────┐
   ▼              ▼           ▼            ▼              ▼              ▼
 auth         device       policy       command       telemetry        file
 service      service     service       service        service        service
   │             │           │             │              │              │
   └─────────┬───┴─────┬─────┴─────────────┴──────────────┴──────────────┘
             ▼         ▼
       Postgres     NATS / Redis              ┌──────────────────────┐
                                              │ notification-service │──▶ MQTT (devices)
                                              └──────────────────────┘
```

See `server/infra/openapi/openapi.yaml` for the public API surface.

## Folder map

```
server/
  auth-service/           JWT issuance, refresh rotation, RBAC
  device-service/         Enrollment, registration, device state machine
  policy-service/         Versioned policies, multi-assign + server-side merge
  command-service/        Remote command dispatch over MQTT + HTTP fallback
  telemetry-service/      Ingestion of device metrics + SIEM activity stream
  notification-service/   MQTT broker bridge, push fanout
  file-service/           APK + photo upload, per-request presigned URLs
  audit-service/          Append-only audit trail of admin actions
  admin-web/              React/TS dashboard (nginx-served, Tailwind, Leaflet)
  shared/                 Go modules shared across services (auth, models, db)
  infra/                  SQL migrations, OpenAPI, Prometheus, Grafana
  k8s/                    Production manifests
android-agent/
  app/                    UI shell + DI graph (Compose)
  mdm-core/               DevicePolicyManager wrapper, DeviceAdminReceiver
  enrollment/             QR parsing, server registration handshake
  policy-engine/          Policy fetch + diff-based apply + persisted last-spec
  command-executor/       CommandService (FG), CommandExecutor, ActivityMonitor,
                          KeepAliveAlarm, AppInstaller
  telemetry/              Periodic collectors + WorkManager jobs
  networking/             Retrofit, MQTT (paho) client, EncryptedSharedPreferences
  security/               Crypto, root/tamper detection
  buildSrc/               Centralized dependency versions
```

## What is NOT included (per spec)

- Kiosk mode / lock-task workflows
- Launcher replacement

## Security posture

- All inter-service auth uses short-lived JWTs (15 min access, 7 day refresh) with rotation.
- **RBAC** enforced server-side on every admin route via a centralized permission matrix (`shared/authz`); the UI only mirrors it. Command issuance is risk-tiered per kind; user/role management is hierarchy-gated (no privilege escalation). Authorization denials are logged.
- Device-to-server: mTLS optional, JWT mandatory, certificate pinning on the agent. Device tokens (`knd=device`) are a strictly separate principal class from user tokens.
- All sensitive on-device storage uses AES-256 via Android Keystore + EncryptedSharedPreferences.
- Database has RLS-ready `tenant_id` on every business table; ready for `SET LOCAL app.current_tenant` enforcement.
- Audit log is append-only with hash-chained records; the admin UI resolves actors to emails and targets to device names.

## License

Apache 2.0. See `LICENSE`.
