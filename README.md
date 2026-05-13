# CyberSentinel MDM

**Product:** CyberSentinel MDM
**Vendor:** Virtual Galaxy Infotech Ltd

Production-grade Android Enterprise MDM platform inspired by Intune / SOTI / Workspace ONE, focused exclusively on Android Enterprise (Device Owner mode). Multi-tenant ready, container-native, scalable to thousands of concurrent devices.

```
/server          Go microservices + React admin web
/android-agent   Kotlin/Compose Android Enterprise agent (Device Owner)
```

## Stack at a glance

| Layer            | Tech                                                          |
|------------------|---------------------------------------------------------------|
| Backend services | Go 1.22, Fiber v2, gRPC, sqlx                                 |
| Database         | PostgreSQL 16 (multi-tenant via row-level `tenant_id`)        |
| Cache / sessions | Redis 7                                                       |
| Event bus        | NATS JetStream                                                |
| Realtime push    | MQTT (Eclipse Mosquitto) + WebSockets                         |
| Object storage   | MinIO (S3 compatible)                                         |
| API gateway      | Traefik v3                                                    |
| Observability    | Prometheus + Grafana + structured zerolog                     |
| Admin UI         | React 18, TypeScript, Vite, Tailwind, TanStack Query, Zustand |
| Mobile agent     | Kotlin, Jetpack Compose, Hilt, Room, WorkManager, Retrofit    |
| Deployment       | Docker Compose (dev), Kubernetes manifests (prod)             |

## Quick start (local)

```bash
cd server
cp .env.example .env
docker compose up -d
# wait ~30s for migrations
docker compose logs -f auth-service device-service command-service
```

Admin UI: http://localhost:8080  (default seeded admin: `admin@mdm.local` / `ChangeMe!123`)
Traefik dashboard: http://localhost:8081
Grafana: http://localhost:3001 (admin / admin)
MinIO console: http://localhost:9001 (minioadmin / minioadmin)

## Enrolling a device

1. In admin UI, **Enrollment → Generate token**. This produces a QR provisioning payload that includes:
   - the DPC package + signature checksum
   - download URL of the signed agent APK
   - a one-time enrollment JWT and the tenant slug
2. Factory-reset Android device → tap the welcome screen 6 times → scan the QR.
3. Android installs the DPC, sets it as Device Owner, and the agent registers itself with the backend.

For ADB provisioning (development):

```bash
adb shell dpm set-device-owner com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver
```

## Service topology

```
                  ┌──────────────────────────────┐
                  │        Traefik (gateway)     │
                  └───────────┬──────────────────┘
                              │  REST + WS
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
  gateway/                Traefik reverse proxy + TLS termination
  auth-service/           JWT issuance, refresh rotation, RBAC, MFA-ready
  device-service/         Enrollment, registration, device state machine
  policy-service/         Versioned policies, diffs, assignment
  command-service/        Remote command dispatch, retries, ack tracking
  telemetry-service/      Ingestion of device metrics, app inventory
  notification-service/   MQTT broker bridge, push fanout
  file-service/           APK upload, signed URLs, file pushes
  audit-service/          Append-only audit trail of admin actions
  admin-web/              React/TS dashboard
  shared/                 Go modules shared across services (auth, models, db)
  infra/                  SQL migrations, OpenAPI, Prometheus, Grafana
  k8s/                    Production manifests
android-agent/
  app/                    UI shell + DI graph (Compose)
  mdm-core/               DevicePolicyManager wrapper, DeviceAdminReceiver
  enrollment/             QR parsing, server registration handshake
  policy-engine/          Policy fetch + diff + apply pipeline
  command-executor/       Command consumer, executor dispatch
  telemetry/              Periodic collectors + WorkManager jobs
  networking/             Retrofit, MQTT client, SSL pinning
  security/               Crypto, root/tamper detection, EncryptedPreferences
  buildSrc/               Centralized dependency versions
```

## What is NOT included (per spec)

- Kiosk mode / lock-task workflows
- Launcher replacement

## Security posture

- All inter-service auth uses short-lived JWTs (15 min access, 7 day refresh) with rotation.
- Device-to-server: mTLS optional, JWT mandatory, certificate pinning on the agent.
- All sensitive on-device storage uses AES-256 via Android Keystore + EncryptedSharedPreferences.
- Database has RLS-ready `tenant_id` on every business table; ready for `SET LOCAL app.current_tenant` enforcement.
- Audit log is append-only with hash-chained records.

## License

Apache 2.0. See `LICENSE`.
