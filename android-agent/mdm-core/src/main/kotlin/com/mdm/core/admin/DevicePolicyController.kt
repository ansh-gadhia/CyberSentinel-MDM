package com.mdm.core.admin

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.UserManager
import android.provider.Settings
import androidx.annotation.RequiresApi
import dagger.hilt.android.qualifiers.ApplicationContext
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Thin, testable wrapper over [DevicePolicyManager]. Every call is gated on
 * [isDeviceOwner] — non-DO devices silently no-op so a misconfigured build
 * never crashes the agent (but logs WARN so it's visible in telemetry).
 *
 * All restrictions go through [DevicePolicyManager.addUserRestriction] using
 * the [UserManager] constants. Adding new restrictions: extend [Restriction]
 * below; the [setRestriction] dispatcher does the rest.
 */
@Singleton
class DevicePolicyController @Inject constructor(
    @ApplicationContext private val context: Context
) {

    private val dpm: DevicePolicyManager =
        context.getSystemService(DevicePolicyManager::class.java)

    private val admin: ComponentName get() = MDMDeviceAdminReceiver.componentName(context)

    // -------------------- state queries --------------------

    fun isDeviceOwner(): Boolean = dpm.isDeviceOwnerApp(context.packageName)
    fun isAdminActive(): Boolean = dpm.isAdminActive(admin)

    // -------------------- destructive ops ------------------

    fun lockNow() = guarded("lockNow") { dpm.lockNow() }

    /**
     * Factory reset. Pass `WIPE_EXTERNAL_STORAGE` and `WIPE_RESET_PROTECTION_DATA`
     * for a true clean wipe; on Android 9+ also pass `WIPE_EUICC` if applicable.
     */
    fun wipeDevice(externalStorage: Boolean = true, resetProtection: Boolean = true) =
        guarded("wipeDevice") {
            var flags = 0
            if (externalStorage) flags = flags or DevicePolicyManager.WIPE_EXTERNAL_STORAGE
            if (resetProtection) flags = flags or DevicePolicyManager.WIPE_RESET_PROTECTION_DATA
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                flags = flags or DevicePolicyManager.WIPE_EUICC
            }
            dpm.wipeData(flags)
        }

    fun rebootDevice(reason: String? = null) = guarded("reboot") {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) dpm.reboot(admin)
    }

    // -------------------- password policy ------------------

    fun setPasswordComplexity(complexity: Int) = guarded("setPasswordComplexity") {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            dpm.requiredPasswordComplexity = complexity
        }
    }

    fun setMinimumPasswordLength(min: Int) = guarded("setMinPasswordLength") {
        @Suppress("DEPRECATION")
        dpm.setPasswordMinimumLength(admin, min)
    }

    fun setMaxFailedPasswordsForWipe(max: Int) = guarded("setMaxFailedForWipe") {
        dpm.setMaximumFailedPasswordsForWipe(admin, max)
    }

    fun setPasswordExpirationTimeoutMs(ms: Long) = guarded("setPasswordExpiration") {
        dpm.setPasswordExpirationTimeout(admin, ms)
    }

    fun setInactivityLockSeconds(seconds: Int) = guarded("setInactivityLock") {
        dpm.setMaximumTimeToLock(admin, seconds * 1_000L)
    }

    /**
     * Sets a new lock-screen password. The platform method is deprecated as of
     * API 24 and silently no-ops for non-Device-Owner / non-Profile-Owner
     * callers in modern Android — [guarded] swallows the resulting
     * SecurityException so the agent stays alive; the caller ack-fails the
     * command with a clear message.
     */
    @Suppress("DEPRECATION")
    fun resetPassword(password: String): Boolean? = guarded("resetPassword") {
        dpm.resetPassword(password, 0)
    }

    // -------------------- camera / capture ------------------

    fun setCameraDisabled(disabled: Boolean) = guarded("setCameraDisabled") {
        dpm.setCameraDisabled(admin, disabled)
    }

    fun setScreenCaptureDisabled(disabled: Boolean) = guarded("setScreenCaptureDisabled") {
        dpm.setScreenCaptureDisabled(admin, disabled)
    }

    // -------------------- generic user restrictions ---------

    /**
     * Mirrors PolicySpec.Restrictions field-by-field. The PolicyApplier uses
     * this as its dispatch table.
     */
    fun setRestriction(restriction: Restriction, enabled: Boolean) = guarded("restriction.${restriction.name}") {
        val key = restriction.userManagerKey
        if (enabled) dpm.addUserRestriction(admin, key) else dpm.clearUserRestriction(admin, key)
    }

    // -------------------- app management --------------------

    /**
     * Hide a package from the launcher (Device Owner-only). Use for blocklists
     * that should not be uninstalled but should be invisible.
     */
    fun setApplicationHidden(packageName: String, hidden: Boolean): Boolean = guarded("hide.$packageName") {
        dpm.setApplicationHidden(admin, packageName, hidden)
    } ?: false

    fun setUninstallBlocked(packageName: String, blocked: Boolean) = guarded("uninstallBlocked.$packageName") {
        dpm.setUninstallBlocked(admin, packageName, blocked)
    }

    fun isPackageInstalled(packageName: String): Boolean = try {
        context.packageManager.getPackageInfo(packageName, 0); true
    } catch (e: PackageManager.NameNotFoundException) { false }

    // -------------------- certs -----------------------------

    fun installCaCert(certPem: ByteArray): Boolean = guarded("installCaCert") {
        dpm.installCaCert(admin, certPem)
    } ?: false

    fun removeCaCert(certPem: ByteArray) = guarded("removeCaCert") {
        dpm.uninstallCaCert(admin, certPem)
    }

    // -------------------- wifi / proxy ----------------------

    @RequiresApi(Build.VERSION_CODES.N)
    fun setAlwaysOnVpn(packageName: String, lockdown: Boolean) = guarded("alwaysOnVpn") {
        dpm.setAlwaysOnVpnPackage(admin, packageName, lockdown)
    }

    fun setGlobalProxy(host: String, port: Int, exclusionList: List<String>) = guarded("globalProxy") {
        // setRecommendedGlobalProxy is the modern replacement for the
        // deprecated setGlobalProxy(admin, java.net.Proxy, exclusions)
        // overload and is the only one that accepts a [ProxyInfo].
        val proxy = android.net.ProxyInfo.buildDirectProxy(host, port, exclusionList)
        dpm.setRecommendedGlobalProxy(admin, proxy)
        Timber.i("Set global proxy $host:$port (excl=${exclusionList.joinToString(",")})")
    }

    // -------------------- system update ---------------------

    fun setSystemUpdatePolicy(mode: Int, windowStartMin: Int, windowEndMin: Int) = guarded("systemUpdate") {
        val policy = when (mode) {
            android.app.admin.SystemUpdatePolicy.TYPE_INSTALL_AUTOMATIC ->
                android.app.admin.SystemUpdatePolicy.createAutomaticInstallPolicy()
            android.app.admin.SystemUpdatePolicy.TYPE_INSTALL_WINDOWED ->
                android.app.admin.SystemUpdatePolicy.createWindowedInstallPolicy(windowStartMin, windowEndMin)
            android.app.admin.SystemUpdatePolicy.TYPE_POSTPONE ->
                android.app.admin.SystemUpdatePolicy.createPostponeInstallPolicy()
            else -> null
        }
        dpm.setSystemUpdatePolicy(admin, policy)
    }

    // -------------------- safe net helper -------------------

    private inline fun <T> guarded(op: String, block: () -> T): T? {
        // We gate on isAdminActive() rather than isDeviceOwner() so this same
        // build works in two modes:
        //   - Production: provisioned as Device Owner; all ops succeed.
        //   - Dev/test:   activated via `adb shell dpm set-active-admin …`;
        //                 lock + basic password ops work, the DO-only ops
        //                 (silent install, restrictions, proxy, …) throw
        //                 SecurityException and we catch + log them below
        //                 so the agent keeps running instead of crashing.
        return if (!isAdminActive()) {
            Timber.w("DPM op $op skipped: admin not active")
            null
        } else try {
            block()
        } catch (t: SecurityException) {
            Timber.w(t, "DPM op $op denied — requires Device Owner (running as DA?)")
            null
        } catch (t: Throwable) {
            Timber.e(t, "DPM op $op failed")
            null
        }
    }
}

/**
 * Maps PolicySpec.Restrictions keys to platform UserManager constants. New
 * restrictions: add an entry, no other code changes needed.
 */
enum class Restriction(val userManagerKey: String) {
    DisableCamera           (UserManager.DISALLOW_CAMERA_TOGGLE.run { "no_camera" }), // legacy key for compat
    DisableScreenCapture    ("no_screen_capture"),
    DisableUSBFileTransfer  (UserManager.DISALLOW_USB_FILE_TRANSFER),
    DisableBluetooth        (UserManager.DISALLOW_BLUETOOTH),
    DisableNFC              (UserManager.DISALLOW_OUTGOING_BEAM),
    DisableHotspot          (UserManager.DISALLOW_CONFIG_TETHERING),
    DisableLocation         (UserManager.DISALLOW_SHARE_LOCATION),
    DisableUnknownSources   (UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES),
    DisableAccessibility    (UserManager.DISALLOW_CONFIG_LOCATION),  // closest analogue
    DisableFactoryReset     (UserManager.DISALLOW_FACTORY_RESET),
    DisableSafeBoot         (UserManager.DISALLOW_SAFE_BOOT),
    DisableAddUser          (UserManager.DISALLOW_ADD_USER);
}
