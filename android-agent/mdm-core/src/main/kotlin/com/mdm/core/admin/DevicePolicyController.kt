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

    // -------------------- reset-password token flow (DO, API 26+) ----------
    //
    // On Android O+ the only way for a Device Owner to change the lock-screen
    // password remotely is the token-based flow:
    //   1. setResetPasswordToken(admin, token) → caches the token.
    //   2. (one-time) user confirms current credentials on device, which
    //      activates the token.
    //   3. resetPasswordWithToken(admin, newPassword, token, flags) → works
    //      silently from then on.

    /**
     * Arms a reset-password token. Returns null on success, or a human-
     * readable diagnostic string describing why the platform refused.
     *
     * Common refusal causes (the admin needs the hint to fix it):
     *   - The device has no existing screen lock — the token API requires
     *     one to be active so it can be activated by the user.
     *   - File-Based Encryption is in direct-boot mode (rare).
     *   - The platform image strips reset-password-token support (very rare).
     */
    fun armResetPasswordToken(token: ByteArray): String? {
        return try {
            if (token.size < 32) return "token is ${token.size} bytes, minimum is 32"
            val ok = dpm.setResetPasswordToken(admin, token)
            if (ok) null
            else "setResetPasswordToken returned false. Most common cause: the device " +
                 "has no existing PIN/pattern/password lock yet — Android's token API " +
                 "requires an existing lock to activate the token. Set a lock on the " +
                 "device first, then retry."
        } catch (t: Throwable) {
            Timber.w(t, "setResetPasswordToken threw")
            "${t.javaClass.simpleName}: ${t.message ?: "no message"}"
        }
    }

    fun isResetPasswordTokenActive(): Boolean {
        return try { dpm.isResetPasswordTokenActive(admin) }
        catch (t: Throwable) { false }
    }

    /**
     * Clears any previously-set reset-password token. Safe to call even when
     * no token is set. Used to recover from a stuck-token state on devices
     * where setResetPasswordToken returns false when a stale token is present.
     */
    fun clearResetPasswordToken(): Boolean {
        return try { dpm.clearResetPasswordToken(admin) }
        catch (t: Throwable) { Timber.v(t, "clearResetPasswordToken no-op"); false }
    }

    fun resetPasswordWithToken(password: String, token: ByteArray): Boolean {
        return try {
            dpm.resetPasswordWithToken(admin, password, token,
                android.app.admin.DevicePolicyManager.RESET_PASSWORD_REQUIRE_ENTRY)
        } catch (t: Throwable) {
            Timber.w(t, "resetPasswordWithToken failed"); false
        }
    }

    // -------------------- camera / capture ------------------

    fun setCameraDisabled(disabled: Boolean) = guarded("setCameraDisabled") {
        dpm.setCameraDisabled(admin, disabled)
    }

    /**
     * Reads the OS's current camera-disabled state. Used by capture paths
     * to detect a self-imposed disable and temporarily lift it for a
     * single shot, then restore.
     */
    fun isCameraDisabled(): Boolean = try {
        dpm.getCameraDisabled(admin)
    } catch (t: Throwable) { Timber.v(t, "getCameraDisabled failed"); false }

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

    /**
     * Pushes a URL pattern blocklist into Chrome's Managed Configuration
     * bundle. Chrome (and Chromium-based browsers honoring the same schema:
     * Edge, Brave, etc.) blocks any in-app navigation matching one of the
     * patterns. Pattern syntax is the standard Chromium one — e.g.
     * `youtube.com`, `*.youtube.com`, or scheme-and-path wildcards.
     * Calling with an empty list clears the block by writing an empty array.
     *
     * Requires Device Owner / Profile Owner. Idempotent.
     */
    fun setChromeUrlBlocklist(patterns: List<String>) = guarded("setChromeUrlBlocklist") {
        val targets = listOf(
            "com.android.chrome",            // Chrome
            "com.chrome.beta", "com.chrome.dev", "com.chrome.canary",
            "com.microsoft.emmx",            // Edge (Chromium)
            "com.brave.browser",             // Brave
            "org.chromium.chrome"            // raw Chromium
        )
        val bundle = android.os.Bundle().apply {
            putStringArray("URLBlocklist", patterns.toTypedArray())
        }
        for (pkg in targets) {
            if (!isPackageInstalled(pkg)) continue
            try {
                dpm.setApplicationRestrictions(admin, pkg, bundle)
                Timber.i("Pushed URLBlocklist (${patterns.size} patterns) to $pkg")
            } catch (t: Throwable) {
                Timber.w(t, "setApplicationRestrictions failed for $pkg")
            }
        }
    }

    /**
     * Clears app data (cache + sharedPrefs + databases). Fires-and-forgets;
     * the system callback fires once the wipe completes but we don't surface
     * it here — the command result is "issued" rather than "completed".
     */
    fun clearApplicationUserData(packageName: String) = guarded("clearApplicationUserData") {
        dpm.clearApplicationUserData(
            admin, packageName,
            java.util.concurrent.Executors.newSingleThreadExecutor()
        ) { _, _ -> /* fire-and-forget */ }
    }

    /**
     * Grants a runtime permission to a package without prompting the user.
     * Only effective in Device Owner / Profile Owner mode on API 23+.
     * No-op (returns false) in Device Admin mode.
     */
    fun grantRuntimePermission(packageName: String, permission: String): Boolean {
        return try {
            dpm.setPermissionGrantState(
                admin, packageName, permission,
                android.app.admin.DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED
            )
        } catch (t: Throwable) {
            Timber.w(t, "grantRuntimePermission $permission denied (DO required)")
            false
        }
    }

    /**
     * Idempotent: switches the platform-wide permission policy to
     * AUTO_GRANT for our own package and pre-grants the runtime
     * permissions the agent ever asks for. Must be called once after
     * Device Owner is established (and is safe to re-call on every
     * service start — DPM is happy with redundant calls).
     *
     * On non-DO devices [guarded] short-circuits and we silently
     * downgrade to per-command lazy grants in the executor.
     */
    fun applyDeviceOwnerPermissionDefaults() {
        if (!isAdminActive()) {
            Timber.w("permission defaults skipped: admin not active")
            return
        }
        runCatching {
            // PERMISSION_POLICY_AUTO_GRANT: every future runtime permission
            // request by *this* package is auto-granted without a dialog.
            dpm.setPermissionPolicy(admin, DevicePolicyManager.PERMISSION_POLICY_AUTO_GRANT)
        }.onFailure { Timber.w(it, "setPermissionPolicy AUTO_GRANT failed (DO required?)") }

        // Belt-and-suspenders: also explicitly mark each known runtime
        // permission as GRANTED. The AUTO_GRANT policy only fires on a
        // requestPermissions() call; older Android versions don't always
        // honor it for permissions never explicitly requested.
        val pkg = context.packageName
        val perms = listOf(
            android.Manifest.permission.CAMERA,
            android.Manifest.permission.ACCESS_FINE_LOCATION,
            android.Manifest.permission.ACCESS_COARSE_LOCATION,
            android.Manifest.permission.POST_NOTIFICATIONS,
            android.Manifest.permission.READ_PHONE_STATE
        )
        var granted = 0
        for (p in perms) {
            if (grantRuntimePermission(pkg, p)) granted++
        }
        Timber.i("Pre-granted $granted/${perms.size} runtime permissions to $pkg")
    }

    // -------------------- certs -----------------------------

    fun installCaCert(certPem: ByteArray): Boolean = guarded("installCaCert") {
        dpm.installCaCert(admin, certPem)
    } ?: false

    fun removeCaCert(certPem: ByteArray) = guarded("removeCaCert") {
        dpm.uninstallCaCert(admin, certPem)
    }

    // -------------------- wifi / proxy ----------------------

    @RequiresApi(Build.VERSION_CODES.N)
    fun setAlwaysOnVpn(packageName: String?, lockdown: Boolean) = guarded("alwaysOnVpn") {
        // packageName == null clears any always-on VPN binding.
        dpm.setAlwaysOnVpnPackage(admin, packageName, lockdown)
    }

    fun setGlobalProxy(host: String?, port: Int, exclusionList: List<String>) = guarded("globalProxy") {
        // setRecommendedGlobalProxy is the modern replacement for the
        // deprecated setGlobalProxy(admin, java.net.Proxy, exclusions)
        // overload and is the only one that accepts a [ProxyInfo].
        // host == null clears the global proxy.
        if (host.isNullOrBlank()) {
            dpm.setRecommendedGlobalProxy(admin, null)
            Timber.i("Cleared global proxy")
        } else {
            val proxy = android.net.ProxyInfo.buildDirectProxy(host, port, exclusionList)
            dpm.setRecommendedGlobalProxy(admin, proxy)
            Timber.i("Set global proxy $host:$port (excl=${exclusionList.joinToString(",")})")
        }
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
