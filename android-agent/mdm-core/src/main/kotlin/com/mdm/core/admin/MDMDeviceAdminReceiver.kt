package com.mdm.core.admin

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PersistableBundle
import timber.log.Timber

/**
 * Receives DPC lifecycle callbacks from the platform.
 *
 * Key responsibilities:
 *   - on ENABLED: nothing to do here; the agent's [MDMApplication] kicks off
 *     the foreground service if Device Owner is set.
 *   - on PROFILE_PROVISIONING_COMPLETE: this is invoked AFTER the Setup
 *     Wizard finishes the QR/afw# provisioning. We:
 *       1. Read the AdminExtras bundle (server URL + enrollment token);
 *       2. Persist them so [EnrollmentManager] picks them up on first launch;
 *       3. Activate sensible defaults (clear initial app-state lock).
 *   - on BOOT_COMPLETED: re-arm WorkManager / restart command service.
 */
class MDMDeviceAdminReceiver : DeviceAdminReceiver() {

    companion object {
        fun componentName(ctx: Context) = ComponentName(ctx, MDMDeviceAdminReceiver::class.java)

        // Decoupled service start: avoid a compile-time dep on :command-executor
        // (which itself depends on :mdm-core, which would create a cycle).
        private const val SERVICE_CLASS = "com.mdm.command.CommandService"

        private fun startCommandService(ctx: Context) {
            val intent = Intent().setComponent(ComponentName(ctx.packageName, SERVICE_CLASS))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent)
            else ctx.startService(intent)
        }
    }

    override fun onEnabled(context: Context, intent: Intent) {
        super.onEnabled(context, intent)
        Timber.i("DeviceAdmin enabled")
    }

    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        super.onProfileProvisioningComplete(context, intent)
        val extras: PersistableBundle? =
            intent.getParcelableExtra(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE)
        if (extras != null) {
            val serverUrl = extras.getString("server_url").orEmpty()
            val token = extras.getString("enrollment_token").orEmpty()
            val tenant = extras.getString("tenant_id").orEmpty()
            Timber.i("Provisioning complete; server=$serverUrl tenant=$tenant")
            // Persist for first-boot pickup. Stored via EncryptedSharedPreferences
            // by ProvisioningStash so the EnrollmentManager can read it.
            ProvisioningStash(context).save(serverUrl, token, tenant)
        }

        // Allow Settings + Play Store to operate; clear any default disabling.
        val dpm = context.getSystemService(DevicePolicyManager::class.java)
        val admin = componentName(context)
        // Mandatory for Device Owner: enable the app on boot so the user can
        // continue out of Setup.
        dpm.setProfileEnabled(admin)

        // Pre-grant every runtime permission the agent will ever need so the
        // first CAPTURE_PHOTO / GET_LOCATION / etc. command doesn't hit a
        // system permission dialog. Cheap and idempotent.
        runCatching { DevicePolicyController(context.applicationContext).applyDeviceOwnerPermissionDefaults() }
            .onFailure { Timber.w(it, "pre-grant permissions failed at provisioning") }

        // Start command channel now that we're Device Owner.
        startCommandService(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            // Re-arm worker chain and command service on reboot.
            startCommandService(context)
        }
    }

    override fun onPasswordFailed(context: Context, intent: Intent) {
        // Could trigger PASSWORD_FAILED telemetry or attempt-based wipe here.
        Timber.w("Password failed; failed=${context.getSystemService(DevicePolicyManager::class.java).currentFailedPasswordAttempts}")
    }
}
