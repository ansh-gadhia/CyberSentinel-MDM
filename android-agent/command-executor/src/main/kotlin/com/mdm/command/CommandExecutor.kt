package com.mdm.command

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import com.mdm.core.admin.DevicePolicyController
import com.mdm.core.admin.Restriction
import com.mdm.networking.api.CommandDto
import com.mdm.networking.api.CommandResultDto
import com.mdm.networking.api.MdmApi
import com.mdm.networking.auth.AuthRepository
import com.mdm.policy.PolicyEngine
import com.mdm.security.IntegrityChecker
import com.mdm.telemetry.TelemetryCollector
import dagger.hilt.android.qualifiers.ApplicationContext
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
    private val api: MdmApi,
    private val auth: AuthRepository
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

        CommandKind.INSTALL_APP -> {
            installer.install(
                packageName = p.str("package_name"),
                downloadObjectId = p["download_object_id"] as? String,
                directUrl = p["download_url"] as? String
            ); null
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
            val ok = dpm.resetPassword(newPassword)
            if (ok != true) error("resetPassword returned $ok (needs Device Owner on API 24+)")
            null
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
            val pm = context.packageManager
            val includeSystem = p.bool("include_system", false)
            val apps = pm.getInstalledApplications(PackageManager.GET_META_DATA)
                .asSequence()
                .filter { includeSystem || (it.flags and ApplicationInfo.FLAG_SYSTEM) == 0
                          || (it.flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0 }
                .mapNotNull { info ->
                    val pi = runCatching { pm.getPackageInfo(info.packageName, 0) }.getOrNull() ?: return@mapNotNull null
                    mapOf(
                        "package"        to info.packageName,
                        "label"          to pm.getApplicationLabel(info).toString(),
                        "version_name"   to (pi.versionName ?: ""),
                        "version_code"   to pi.versionCodeCompat(),
                        "system"         to ((info.flags and ApplicationInfo.FLAG_SYSTEM) != 0),
                        "enabled"        to info.enabled,
                        "first_install"  to pi.firstInstallTime,
                        "last_update"    to pi.lastUpdateTime
                    )
                }
                .toList()
            mapOf("count" to apps.size, "apps" to apps, "fetched_at" to nowIso())
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
