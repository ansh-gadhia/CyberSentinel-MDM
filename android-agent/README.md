# CyberSentinel MDM — Android Agent

**Vendor:** Virtual Galaxy Infotech Ltd

The on-device companion to the CyberSentinel MDM server. Built as a multi-module Gradle
project so the heavy DPM / MQTT machinery stays out of the UI module and is
trivially mockable in tests.

## Modules

| Module             | Purpose                                                                          |
|--------------------|----------------------------------------------------------------------------------|
| `:app`             | Compose UI, `MDMApplication`, `MainActivity`                                     |
| `:mdm-core`        | `DevicePolicyController`, `MDMDeviceAdminReceiver`, `ProvisioningStash`          |
| `:networking`      | Retrofit + OkHttp + paho MQTT, `AuthRepository`, `TokenStore`                    |
| `:security`        | `CryptoManager`, `RootDetector`, `IntegrityChecker`                              |
| `:enrollment`      | `EnrollmentManager`, QR payload parsing, first-boot worker                       |
| `:policy-engine`   | `PolicySpec` (typed), `PolicyEngine`, `PolicyApplier` with diff-based reset      |
| `:command-executor`| `CommandService` (foreground), `CommandExecutor`, `ActivityMonitor`, `KeepAliveAlarm`, `AppInstaller`, `AudioStreamManager` (segmented mic capture), `MessageActivity` (on-screen message popup) |
| `:telemetry`       | `TelemetryCollector`, `TelemetryWorker`                                          |

Dependency direction:

```
app → enrollment, policy-engine, command-executor, telemetry
              ↘            ↘             ↘
              mdm-core ── networking ── security
```

## Management modes

The agent runs whether or not it holds an admin role. `MainViewModel` no longer gates on admin — install + enroll alone reaches the home screen ("enrolled-only" mode). The home screen shows the current mode, optional elevation instructions, and a **Permissions panel** that requests the runtime permissions (camera/mic/location/notifications) and the Usage-Access special-access grant — essential in Device Admin / enrolled-only modes where nothing is auto-granted. `CommandService` starts whenever enrolled (any mode), and reports the mode (`owner`/`admin`/`none`) on every heartbeat.

## What the agent does on the device

- **Foreground service** (`CommandService`) maintains MQTT + HTTP poll fallback + Doze-resistant `KeepAliveAlarm` (3-minute cadence) so an OS kill is recovered within minutes rather than the 15-min WorkManager floor. Its foreground-service **types are computed dynamically** — camera/mic/location are declared only when the matching runtime permission is currently held (Android 14 rejects the FGS otherwise), so it doesn't crash in non-owner modes.
- **CommandExecutor** dispatches every server-side command kind: LOCK, WIPE, REBOOT, APPLY_POLICY, **CLEAR_POLICY** (rolls back camera-disable, all `UserRestriction`s, app + URL blocklists, surveillance toggles), INSTALL_APP / UNINSTALL_APP via PackageInstaller sessions, HIDE/SHOW/BLOCK/ALLOW app, CLEAR_APP_DATA, CAPTURE_PHOTO with lift-and-restore around `setCameraDisabled`, **START/STOP_AUDIO_STREAM**, **SHOW_MESSAGE**, RESET_PASSWORD via the DO reset-password token machinery, GET_LOCATION, SET_VPN, SET_PROXY, etc.
- **AudioStreamManager** records the mic as short AAC/**ADTS** segments (byte-concatenable, so the server can stitch a session into one file), uploading each as it finishes. `start()` awaits and reports the first segment's outcome so a silent mic/permission/upload failure surfaces in the command result instead of recording into the void.
- **MessageActivity** shows an admin-pushed message as a dialog (show-when-locked + turn-screen-on); the command also raises a high-priority full-screen-intent notification so the message lands across all modes.
- **ActivityMonitor** registers broadcast receivers for screen on/off, USER_PRESENT, power, connectivity, package events, and a 3 s `UsageStatsManager.queryEvents` poll for per-app foreground tracking. Every event ships as a telemetry row for the admin's Activity tab. On the first detection of a missing `PACKAGE_USAGE_STATS` grant it auto-opens the Settings page and posts a sticky notification — that op is signature-protected so even a Device Owner cannot programmatically grant it.
- **PolicyEngine + PolicyApplier**: fetches the merged effective policy from the server, decodes via kotlinx-serialization (`ignoreUnknownKeys=true`), and reflects it onto the device. Persists the last-applied spec to TokenStore so the next apply can diff: any field set previously but absent now gets explicitly reset (otherwise null-means-preserve strands the device in the prior state after unassign).
- **Surveillance**: `capture_on_unlock` policy snaps the front camera on every USER_PRESENT and uploads via the device-authenticated file endpoint.

## Build

```bash
cd android-agent
./build-apk.sh             # debug APK (Docker-based; no host JDK required)
# or
./gradlew :app:assembleDebug
```

Output: `app/build/outputs/apk/debug/app-debug.apk`.

## Provisioning

Two paths:

1. **QR / `afw#` enrollment**: factory reset, scan the QR generated by the
   admin console. Setup Wizard hands off to
   `MDMDeviceAdminReceiver.onProfileProvisioningComplete`, which stashes the
   token in `ProvisioningStash` and starts `CommandService`.

2. **adb (dev only)** — pick the mode you want:
   ```bash
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   # Device Owner (full control; device must be freshly reset / no accounts):
   adb shell dpm set-device-owner   com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver
   # …or Device Admin (subset; no reset needed):
   adb shell dpm set-active-admin   com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver
   # …or neither — just launch the app and enroll for read-only "enrolled-only" mode.
   ```
   Then launch the app, enter the server URL / token, and use the Permissions panel to grant what the active mode needs.

On first launch the agent auto-launches Usage Access settings + posts a notification so the user can grant `PACKAGE_USAGE_STATS` with one tap. Until granted, every other activity stream still flows; only the per-app foreground tracking is gated.

## Testing

Unit tests live under each module's `src/test`. CI runs them via:

```bash
./gradlew test
```
