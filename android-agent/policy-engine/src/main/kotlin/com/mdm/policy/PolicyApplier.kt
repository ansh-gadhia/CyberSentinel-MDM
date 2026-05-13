package com.mdm.policy

import com.mdm.core.admin.DevicePolicyController
import com.mdm.core.admin.Restriction
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Walks a [PolicySpec] and reflects it onto the device via [DevicePolicyController].
 *
 * Field-level semantics:
 *   - null  → leave the previous policy value alone
 *   - false → explicitly clear / allow
 *   - true  → explicitly enforce / disable
 *
 * App install/uninstall are delegated to AppInstaller below — Device Owner
 * install flows go through PackageInstaller sessions, not DPM directly.
 *
 * NOTE: this class is the *idempotent* projection of a PolicySpec onto the
 * device. Calling apply() with the same spec twice MUST be a no-op. If you
 * find yourself needing transient state, push it into PolicyEngine.
 */
@Singleton
class PolicyApplier @Inject constructor(
    private val dpm: DevicePolicyController
) {

    fun apply(spec: PolicySpec) {
        Timber.i("Applying policy spec")
        spec.restrictions?.let(::applyRestrictions)
        spec.password?.let(::applyPassword)
        spec.network?.let(::applyNetwork)
        spec.apps?.let(::applyApps)
        spec.system_update?.let(::applySystemUpdate)
        spec.certificates.forEach(::applyCertificate)
        // Compliance is reported back to the server; nothing local to apply.
    }

    private fun applyRestrictions(r: Restrictions) {
        // Camera + capture have dedicated DPM setters distinct from UserRestrictions.
        r.disable_camera?.let { dpm.setCameraDisabled(it) }
        r.disable_screen_capture?.let { dpm.setScreenCaptureDisabled(it) }

        // Generic UserRestriction dispatcher — null preserves prior state.
        mapOf(
            Restriction.DisableUSBFileTransfer to r.disable_usb_file_transfer,
            Restriction.DisableBluetooth      to r.disable_bluetooth,
            Restriction.DisableNFC            to r.disable_nfc,
            Restriction.DisableHotspot        to r.disable_hotspot,
            Restriction.DisableLocation       to r.disable_location,
            Restriction.DisableUnknownSources to r.disable_unknown_sources,
            Restriction.DisableAccessibility  to r.disable_accessibility,
            Restriction.DisableFactoryReset   to r.disable_factory_reset,
            Restriction.DisableSafeBoot       to r.disable_safe_boot,
            Restriction.DisableAddUser        to r.disable_add_user
        ).forEach { (key, v) -> if (v != null) dpm.setRestriction(key, v) }
    }

    private fun applyPassword(p: PasswordPolicy) {
        p.complexity?.let { dpm.setPasswordComplexity(it) }
        p.minimum_length?.let { dpm.setMinimumPasswordLength(it) }
        p.max_failed_for_wipe?.let { dpm.setMaxFailedPasswordsForWipe(it) }
        p.expiration_ms?.let { dpm.setPasswordExpirationTimeoutMs(it) }
        p.inactivity_lock_seconds?.let { dpm.setInactivityLockSeconds(it) }
    }

    private fun applyNetwork(n: NetworkPolicy) {
        n.always_on_vpn_package?.let { dpm.setAlwaysOnVpn(it, n.always_on_vpn_lockdown) }
        if (n.proxy_host != null && n.proxy_port != null) {
            dpm.setGlobalProxy(n.proxy_host, n.proxy_port, n.proxy_exclusions)
        }
    }

    private fun applyApps(a: AppPolicy) {
        a.blocklist.forEach { pkg ->
            dpm.setApplicationHidden(pkg, true)
            dpm.setUninstallBlocked(pkg, true)
        }
        // Install / uninstall flow: actual side-effects live in command-executor
        // (PackageInstaller sessions need a foreground service context). The
        // policy applier records intent; CommandExecutor enacts it via a
        // synthetic INSTALL_APP/UNINSTALL_APP command when the spec changes.
        if (a.install.isNotEmpty() || a.uninstall.isNotEmpty()) {
            Timber.d("Policy lists ${a.install.size} installs, ${a.uninstall.size} uninstalls — " +
                     "delegated to CommandExecutor")
        }
    }

    private fun applySystemUpdate(s: SystemUpdatePolicy) {
        dpm.setSystemUpdatePolicy(s.mode, s.window_start_min, s.window_end_min)
    }

    private fun applyCertificate(c: Certificate) {
        val pem = runCatching { android.util.Base64.decode(c.pem_base64, android.util.Base64.DEFAULT) }
            .getOrElse { Timber.w(it, "bad cert base64: ${c.id}"); return }
        if (c.install) dpm.installCaCert(pem) else dpm.removeCaCert(pem)
    }
}
