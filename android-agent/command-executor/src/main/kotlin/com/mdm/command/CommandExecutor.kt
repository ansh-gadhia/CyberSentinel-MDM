package com.mdm.command

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import com.mdm.camera.Buzzer
import com.mdm.camera.CameraCapture
import com.mdm.camera.LocationFix
import com.mdm.core.admin.DevicePolicyController
import com.mdm.core.admin.ResetPasswordTokenStore
import com.mdm.core.admin.Restriction
import com.mdm.networking.api.CommandDto
import com.mdm.networking.api.CommandResultDto
import com.mdm.networking.api.MdmApi
import com.mdm.networking.auth.AuthRepository
import com.mdm.networking.auth.TokenStore
import com.mdm.core.admin.Restriction as RestrictionType
import com.mdm.policy.PolicyEngine
import com.mdm.security.IntegrityChecker
import com.mdm.telemetry.TelemetryCollector
import dagger.hilt.android.qualifiers.ApplicationContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Dispatches one [CommandDto] to the right side-effect and reports the
 * outcome back to the server via `POST /api/v1/commands/{id}/result`.
 *
 * Idempotency: each branch is responsible for its own. MQTT delivery is
 * QoS 1 (at-least-once); duplicate INSTALL_APP / SET_RESTRICTION calls must
 * yield the same end state.
 *
 * Exhaustive `when` is intentional — any new [CommandKind] is a compile
 * error here, which is exactly what we want.
 */
@Singleton
class CommandExecutor @Inject constructor(
    @ApplicationContext private val context: Context,
    private val dpm: DevicePolicyController,
    private val installer: AppInstaller,
    private val policyEngine: PolicyEngine,
    private val collector: TelemetryCollector,
    private val integrity: IntegrityChecker,
    private val camera: CameraCapture,
    private val locator: LocationFix,
    private val buzzer: Buzzer,
    private val resetTokens: ResetPasswordTokenStore,
    private val api: MdmApi,
    private val auth: AuthRepository,
    private val tokens: TokenStore
) {

    suspend fun execute(cmd: CommandDto) {
        val kind = CommandKind.fromWire(cmd.kind)
        if (kind == null) {
            complete(cmd, success = false, result = null, error = "unknown kind: ${cmd.kind}")
            return
        }
        Timber.i("Executing ${kind.name} id=${cmd.id}")
        try {
            val result = handle(kind, cmd.payload.orEmpty())
            complete(cmd, success = true, result = result, error = null)
        } catch (t: Throwable) {
            Timber.e(t, "Command ${cmd.id} failed")
            complete(cmd, success = false, result = null, error = t.message ?: t::class.java.simpleName)
        }
    }

    /**
     * Returns a result map for commands that produce data (FETCH_*); null
     * for fire-and-forget operations (LOCK, WIPE, etc.).
     */
    private suspend fun handle(kind: CommandKind, p: Map<String, Any?>): Map<String, Any?>? = when (kind) {
        CommandKind.LOCK   -> { dpm.lockNow(); null }
        CommandKind.WIPE   -> {
            dpm.wipeDevice(
                externalStorage = p.bool("external_storage", true),
                resetProtection = p.bool("reset_protection", true)
            ); null
        }
        CommandKind.REBOOT -> { dpm.rebootDevice(p["reason"] as? String); null }

        CommandKind.SYNC_POLICY, CommandKind.APPLY_POLICY -> {
            val v = policyEngine.sync()
            mapOf("applied_version" to v)
        }

        CommandKind.CLEAR_POLICY -> {
            // Roll back everything the PolicyApplier may have set. Each
            // step is independent + idempotent — a partial failure (e.g.
            // setCameraDisabled returns null because we're not actually DO)
            // doesn't abort the others.
            var cleared = 0
            // Camera + screen capture
            dpm.setCameraDisabled(false); cleared++
            dpm.setScreenCaptureDisabled(false); cleared++
            // All user restrictions
            RestrictionType.values().forEach {
                dpm.setRestriction(it, false); cleared++
            }
            // Chrome URL blocklist
            dpm.setChromeUrlBlocklist(emptyList()); cleared++
            tokens.setUrlBlocklist(emptyList())
            // App blocklist: re-show every package we previously hid.
            val prevBlock = tokens.appBlocklist()
            for (pkg in prevBlock) {
                dpm.setApplicationHidden(pkg, false)
                dpm.setUninstallBlocked(pkg, false)
                cleared++
            }
            tokens.setAppBlocklist(emptyList())
            // Surveillance toggles
            tokens.setCaptureOnUnlock(false); cleared++
            // Network: best-effort clear (no-ops if never set).
            runCatching { dpm.setAlwaysOnVpn(null, false) }
            runCatching { dpm.setGlobalProxy(null, 0, emptyList()) }
            // Forget the last-applied spec so the next APPLY_POLICY doesn't
            // try to diff against stale state.
            tokens.setLastAppliedSpecJson(null)
            // Local policy version so the next APPLY_POLICY isn't short-
            // circuited as "unchanged" against the now-stale lastVersion.
            policyEngine.resetLocalVersion()
            mapOf(
                "cleared_actions" to cleared,
                "previous_blocklist" to prevBlock,
                "at" to nowIso()
            )
        }

        CommandKind.INSTALL_APP -> {
            // package_name is optional now — empty means "let the installer
            // resolve from the APK manifest at commit time".
            val pkg = p["package_name"] as? String
            installer.install(
                packageName = pkg,
                downloadObjectId = p["download_object_id"] as? String,
                directUrl = p["download_url"] as? String
            )
            mapOf(
                "package_name" to (pkg ?: "(auto)"),
                "silent"       to dpm.isDeviceOwner(),
                "note"         to (if (dpm.isDeviceOwner())
                    "silent install committed"
                else
                    "install dialog presented on device — user must tap Install"),
                "at" to nowIso()
            )
        }
        CommandKind.UNINSTALL_APP    -> { installer.uninstall(p.str("package_name")); null }
        CommandKind.HIDE_APP         -> { dpm.setApplicationHidden(p.str("package_name"), true); null }
        CommandKind.SHOW_APP         -> { dpm.setApplicationHidden(p.str("package_name"), false); null }
        CommandKind.BLOCK_UNINSTALL  -> { dpm.setUninstallBlocked(p.str("package_name"), true); null }
        CommandKind.ALLOW_UNINSTALL  -> { dpm.setUninstallBlocked(p.str("package_name"), false); null }

        CommandKind.INSTALL_CERT -> {
            val pem = android.util.Base64.decode(p.str("pem_base64"), android.util.Base64.DEFAULT)
            dpm.installCaCert(pem); null
        }
        CommandKind.REMOVE_CERT -> {
            val pem = android.util.Base64.decode(p.str("pem_base64"), android.util.Base64.DEFAULT)
            dpm.removeCaCert(pem); null
        }

        CommandKind.SET_VPN   -> { dpm.setAlwaysOnVpn(p.str("package_name"), p.bool("lockdown", false)); null }
        CommandKind.SET_PROXY -> {
            @Suppress("UNCHECKED_CAST")
            val excl = (p["exclusions"] as? List<String>) ?: emptyList()
            dpm.setGlobalProxy(p.str("host"), p.int("port"), excl); null
        }
        CommandKind.SET_RESTRICTION -> {
            val name = p.str("key")
            val enabled = p.bool("enabled", true)
            val r = runCatching { Restriction.valueOf(name) }.getOrNull()
                ?: error("unknown restriction: $name")
            dpm.setRestriction(r, enabled); null
        }
        CommandKind.SET_PASSWORD_POLICY -> {
            (p["complexity"] as? Number)?.toInt()?.let { dpm.setPasswordComplexity(it) }
            (p["minimum_length"] as? Number)?.toInt()?.let { dpm.setMinimumPasswordLength(it) }
            (p["max_failed_for_wipe"] as? Number)?.toInt()?.let { dpm.setMaxFailedPasswordsForWipe(it) }
            (p["expiration_ms"] as? Number)?.toLong()?.let { dpm.setPasswordExpirationTimeoutMs(it) }
            (p["inactivity_lock_seconds"] as? Number)?.toInt()?.let { dpm.setInactivityLockSeconds(it) }
            null
        }
        CommandKind.SET_SYSTEM_UPDATE -> {
            dpm.setSystemUpdatePolicy(
                mode = p.int("mode"),
                windowStartMin = p["window_start_min"]?.let { (it as Number).toInt() } ?: 0,
                windowEndMin   = p["window_end_min"]?.let   { (it as Number).toInt() } ?: 0
            ); null
        }

        CommandKind.PUSH_TELEMETRY -> null   // periodic worker handles bulk push
        CommandKind.PING           -> mapOf("pong" to true, "at" to nowIso())

        CommandKind.CLEAR_PASSWORD -> {
            // No safe way to clear the lock password without DPM token machinery.
            error("CLEAR_PASSWORD requires Device Owner with a pre-set reset token")
        }
        CommandKind.RESET_PASSWORD -> {
            val newPassword = p["password"] as? String
                ?: error("missing 'password'")
            if (!dpm.isDeviceOwner()) {
                val ok = dpm.resetPassword(newPassword)
                if (ok != true) {
                    error("Direct resetPassword is gated to Device Owner on Android 8+. " +
                          "Promote the agent to Device Owner mode and retry.")
                }
                mapOf("method" to "legacy", "at" to nowIso())
            } else {
                val token = resetTokens.getOrCreate()
                val active = dpm.isResetPasswordTokenActive()
                if (!active) {
                    // First arm attempt with the existing stored token.
                    var armErr = dpm.armResetPasswordToken(token)
                    if (armErr != null) {
                        // Some platforms reject a fresh setResetPasswordToken when
                        // a stale (but inactive) token is still parked. Clear and
                        // retry once before bailing out.
                        Timber.w("first arm attempt failed: $armErr — clearing token and retrying")
                        dpm.clearResetPasswordToken()
                        armErr = dpm.armResetPasswordToken(token)
                    }
                    if (armErr != null) error("setResetPasswordToken failed: $armErr")
                    error("Reset-password token armed but not yet active. " +
                          "On the device: open Settings → Security → unlock with the CURRENT PIN/pattern/password " +
                          "to activate the token, then retry RESET_PASSWORD from the admin console.")
                }
                val ok = dpm.resetPasswordWithToken(newPassword, token)
                if (!ok) error("resetPasswordWithToken returned false (token may have been invalidated — " +
                               "either the lock screen credentials changed on-device since the token was armed, " +
                               "or the password doesn't meet the device's complexity policy).")
                mapOf("method" to "token", "at" to nowIso())
            }
        }
        CommandKind.LOG_OFF_USER -> error("LOG_OFF_USER not supported on single-user DO")

        CommandKind.FETCH_DEVICE_INFO -> {
            val s = collector.snapshot()
            val ig = integrity.snapshot()
            mapOf(
                "manufacturer"        to s.manufacturer,
                "model"               to s.model,
                "android_version"     to s.androidVersion,
                "sdk"                 to s.sdk,
                "patch_level"         to s.patchLevel,
                "battery_pct"         to s.batteryPct,
                "charging"            to s.charging,
                "network"             to s.network,
                "ip_address"          to s.ipAddress,
                "mac_address"         to s.macAddress,
                "wifi_ssid"           to s.ssid,
                "storage_free_bytes"  to s.storageFreeBytes,
                "storage_total_bytes" to s.storageTotalBytes,
                "rooted"              to ig.rooted,
                "debuggable"          to ig.debuggable,
                "emulator"            to ig.emulator,
                "adb_enabled"         to ig.adbEnabled,
                "signature_sha256"    to ig.selfSignatureSha256,
                "device_owner"        to dpm.isDeviceOwner(),
                "admin_active"        to dpm.isAdminActive(),
                "agent_version"       to AGENT_VERSION,
                "fetched_at"          to nowIso()
            )
        }

        CommandKind.FETCH_APP_INVENTORY -> {
            // Always return every installed app, including system apps —
            // the admin UI filters client-side. The historical
            // `include_system` payload is now ignored; keeping the field
            // accepted for back-compat with older command callers.
            val pm = context.packageManager
            val apps = pm.getInstalledApplications(PackageManager.GET_META_DATA)
                .asSequence()
                .mapNotNull { info ->
                    val pi = runCatching { pm.getPackageInfo(info.packageName, 0) }.getOrNull() ?: return@mapNotNull null
                    mapOf(
                        "package"        to info.packageName,
                        "label"          to pm.getApplicationLabel(info).toString(),
                        "version_name"   to (pi.versionName ?: ""),
                        "version_code"   to pi.versionCodeCompat(),
                        "system"         to ((info.flags and ApplicationInfo.FLAG_SYSTEM) != 0),
                        "updated_system" to ((info.flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0),
                        "enabled"        to info.enabled,
                        "first_install"  to pi.firstInstallTime,
                        "last_update"    to pi.lastUpdateTime
                    )
                }
                .toList()
            mapOf("count" to apps.size, "apps" to apps, "fetched_at" to nowIso())
        }

        CommandKind.CLEAR_APP_DATA -> {
            val pkg = p.str("package_name")
            dpm.clearApplicationUserData(pkg); null
        }

        CommandKind.CAPTURE_PHOTO -> {
            val lensStr = (p["lens"] as? String)?.uppercase() ?: "BACK"
            val lens = when (lensStr) {
                "FRONT" -> CameraCapture.Lens.FRONT
                else    -> CameraCapture.Lens.BACK
            }
            val withFlash = p.bool("with_flash", false)
            val granted = dpm.grantRuntimePermission(context.packageName, android.Manifest.permission.CAMERA)
            // DPM.setCameraDisabled(true) blocks the camera for ALL apps,
            // including this DPC. Briefly lift it for the capture, then
            // restore — otherwise the admin's "disable_camera" policy makes
            // CAPTURE_PHOTO permanently impossible.
            val cameraWasDisabled = dpm.isCameraDisabled()
            if (cameraWasDisabled) {
                Timber.i("CAPTURE_PHOTO: lifting camera-disabled for capture")
                dpm.setCameraDisabled(false)
            }
            Timber.i("CAPTURE_PHOTO: granted=$granted device_owner=${dpm.isDeviceOwner()} " +
                     "admin_active=${dpm.isAdminActive()} camera_was_disabled=$cameraWasDisabled")
            val capture = try {
                camera.capture(lens, withFlash)
            } finally {
                if (cameraWasDisabled) dpm.setCameraDisabled(true)
            }
            when (val res = capture) {
                is CameraCapture.CameraResult.Error -> error(res.reason)
                is CameraCapture.CameraResult.Success -> {
                    val fileName = "photo_${System.currentTimeMillis()}.jpg"
                    val body = res.jpeg.toRequestBody("image/jpeg".toMediaTypeOrNull())
                    val part = MultipartBody.Part.createFormData("file", fileName, body)
                    val kindBody = "photo".toRequestBody("text/plain".toMediaTypeOrNull())
                    val nameBody = fileName.toRequestBody("text/plain".toMediaTypeOrNull())
                    val resp = api.deviceUpload(part, kindBody, nameBody)
                    if (!resp.isSuccessful) {
                        error("upload failed HTTP ${resp.code()}")
                    }
                    val r = resp.body()!!
                    mapOf(
                        "file_id"  to r.id,
                        "sha256"   to r.sha256,
                        "size"     to r.sizeBytes,
                        "lens"     to lens.name,
                        "width_px"  to res.widthPx,
                        "height_px" to res.heightPx,
                        "captured_at" to nowIso()
                    )
                }
            }
        }

        CommandKind.SET_FLASHLIGHT -> {
            val on = p.bool("on", true)
            val ok = camera.setTorch(on)
            if (!ok) error("torch toggle failed (no flash unit or in use)")
            mapOf("on" to on, "at" to nowIso())
        }

        CommandKind.PLAY_SOUND -> {
            val durationMs = (p["duration_ms"] as? Number)?.toLong() ?: 10_000L
            buzzer.ringFor(durationMs)
            mapOf("ringing_ms" to durationMs, "at" to nowIso())
        }

        CommandKind.GET_LOCATION -> {
            // Auto-grant location in DO mode so the agent can resolve a fix
            // without user interaction. NOP in DA mode (and a useful failure
            // mode — empty result tells the admin to enable location).
            dpm.grantRuntimePermission(context.packageName, android.Manifest.permission.ACCESS_FINE_LOCATION)
            val s = locator.get()
            if (s == null) {
                error("no location available (provider disabled or permission denied)")
            }
            mapOf(
                "latitude"   to s.latitude,
                "longitude"  to s.longitude,
                "accuracy_m" to s.accuracyM,
                "provider"   to s.provider,
                "fix_at"     to s.timestamp,
                "fresh"      to s.isFresh
            )
        }

        CommandKind.COLLECT_LOGS -> {
            // Reading the system logcat requires READ_LOGS, which user apps
            // can't hold. We return a best-effort device-state snapshot the
            // admin can correlate against server-side audit; for full logs
            // the admin must `adb shell logcat` against a debug device.
            val s = collector.snapshot()
            val ig = integrity.snapshot()
            mapOf(
                "note"        to "Full logcat requires READ_LOGS (debug-only). " +
                                 "Returning runtime state snapshot instead.",
                "uptime_ms"   to SystemClock.elapsedRealtime(),
                "boot_time"   to (System.currentTimeMillis() - SystemClock.elapsedRealtime()),
                "battery_pct" to s.batteryPct,
                "network"     to s.network,
                "rooted"      to ig.rooted,
                "agent"       to mapOf(
                    "version" to AGENT_VERSION,
                    "device_owner" to dpm.isDeviceOwner(),
                    "admin_active" to dpm.isAdminActive()
                ),
                "fetched_at"  to nowIso()
            )
        }
    }

    private suspend fun complete(cmd: CommandDto, success: Boolean, result: Map<String, Any?>?, error: String?) {
        if (!auth.isEnrolled()) return
        runCatching {
            api.postCommandResult(cmd.id, CommandResultDto(success = success, result = result, error = error))
        }.onFailure { Timber.w(it, "result post failed for ${cmd.id}") }
    }

    private fun nowIso(): String =
        java.time.OffsetDateTime.now(java.time.ZoneOffset.UTC).toString()

    @Suppress("DEPRECATION")
    private fun PackageInfo.versionCodeCompat(): Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) longVersionCode else versionCode.toLong()

    // ---------- payload helpers ----------
    private fun Map<String, Any?>.str(k: String): String =
        (this[k] as? String) ?: error("missing string '$k'")
    private fun Map<String, Any?>.int(k: String): Int =
        (this[k] as? Number)?.toInt() ?: error("missing int '$k'")
    private fun Map<String, Any?>.bool(k: String, default: Boolean): Boolean =
        (this[k] as? Boolean) ?: default

    private companion object { const val AGENT_VERSION = "1.0.0" }
}
