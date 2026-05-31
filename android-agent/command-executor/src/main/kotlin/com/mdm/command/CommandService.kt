package com.mdm.command

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import com.mdm.camera.LocationFix
import com.mdm.core.admin.DevicePolicyController
import com.mdm.networking.api.HeartbeatDto
import com.mdm.networking.api.MdmApi
import com.mdm.networking.auth.AuthRepository
import com.mdm.networking.auth.TokenStore
import com.mdm.networking.mqtt.MdmMqttClient
import com.mdm.policy.PolicySyncWorker
import com.mdm.telemetry.TelemetryCollector
import com.mdm.telemetry.TelemetryWorker
import com.squareup.moshi.JsonAdapter
import com.squareup.moshi.Moshi
import com.squareup.moshi.adapter
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import timber.log.Timber
import javax.inject.Inject

/**
 * Always-on foreground service that maintains the MQTT command channel and
 * runs a low-frequency HTTP poll as a fallback. Lifecycle:
 *
 *   onCreate → start as data-sync foreground service (silent notification)
 *   onStartCommand → idempotent; wire MQTT once tokens are available
 *   onDestroy → cancel scope, disconnect MQTT
 *
 * If the OS kills the service (low memory etc.), Android restarts it because
 * we return [START_STICKY]; on Device Owner devices it's also exempt from
 * battery-optimization kills.
 *
 * NOTE: the service intentionally does NOT block on enrollment — if the
 * device hasn't been enrolled yet, MQTT stays disconnected and we just keep
 * polling-with-backoff until tokens appear. This is what lets the UI flow
 * own enrollment while the service handles long-term operation.
 */
@AndroidEntryPoint
class CommandService : Service() {

    @Inject lateinit var auth: AuthRepository
    @Inject lateinit var tokens: TokenStore
    @Inject lateinit var mqtt: MdmMqttClient
    @Inject lateinit var executor: CommandExecutor
    @Inject lateinit var api: MdmApi
    @Inject lateinit var moshi: Moshi
    @Inject lateinit var collector: TelemetryCollector
    @Inject lateinit var locator: LocationFix
    @Inject lateinit var dpm: DevicePolicyController
    @Inject lateinit var activityMonitor: ActivityMonitor

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var mqttJob: Job? = null
    private var pollJob: Job? = null
    private var heartbeatJob: Job? = null
    private lateinit var commandAdapter: JsonAdapter<com.mdm.networking.api.CommandDto>

    override fun onCreate() {
        super.onCreate()
        @OptIn(ExperimentalStdlibApi::class)
        commandAdapter = moshi.adapter<com.mdm.networking.api.CommandDto>()
        startForegroundSafely()
        // Idempotent — pre-grant runtime permissions + flip AUTO_GRANT on
        // every service start. Fixes the case where the device was already
        // provisioned (so onProfileProvisioningComplete won't fire again)
        // but the agent build is new and hadn't run the grant yet.
        runCatching { dpm.applyDeviceOwnerPermissionDefaults() }
            .onFailure { Timber.w(it, "permission defaults failed at service start") }
        // Arm the Doze-resistant alarm chain on every service create so any
        // future OS kill is recovered within ~3 minutes (the alarm cadence)
        // rather than waiting for WorkManager's 15-min floor.
        KeepAliveAlarm.schedule(applicationContext)
        Timber.i("CommandService started")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Re-assert the foreground notification + FG service types on every
        // (re)start. This is how a sensor permission granted AFTER the service
        // first came up (e.g. the user grants CAMERA via the Permissions panel
        // in Device Admin / enrolled-only mode) gets folded into the FGS type
        // mask — letting a subsequent photo/audio capture actually run.
        runCatching { startForegroundSafely() }
            .onFailure { Timber.w(it, "re-assert foreground failed") }
        ensureWired()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        activityMonitor.stop()
        scope.cancel()
        mqtt.disconnect()
        super.onDestroy()
    }

    private fun ensureWired() {
        if (mqttJob != null) return
        // KeepAlive runs even before enrollment so a never-enrolled device
        // still gets the service respawned (otherwise an OS kill in the
        // pre-enrollment window would mean the user has to manually open
        // the app to get the agent back).
        KeepAliveWorker.schedule(applicationContext)
        mqttJob = scope.launch {
            while (!auth.isEnrolled()) delay(10_000)
            wireMqtt()
            startPollLoop()
            startFastHeartbeat()
            activityMonitor.start(scope)
            // Schedule periodic background work now that we have credentials.
            PolicySyncWorker.schedule(applicationContext)
            TelemetryWorker.schedule(applicationContext)
        }
    }

    /**
     * Fast heartbeat loop. Posts /devices/me/heartbeat every [HEARTBEAT_MS]
     * (60s) so the admin "Connected" indicator stays green and so the
     * device's IP/MAC + last-known location stay fresh on the server.
     *
     * - IP / MAC: read on every tick (cheap).
     * - Location: refreshed every [LOCATION_REFRESH_MS] (5 min) to avoid
     *   waking GPS each minute. We piggy-back the cached fix on subsequent
     *   heartbeats so the admin UI sees a moving dot every minute even
     *   though the underlying provider only fires every 5 minutes.
     *
     * The body is wrapped in a try/catch around the WHOLE iteration so a
     * single bad response (auth blip, network hiccup) can't kill the loop.
     */
    private fun startFastHeartbeat() {
        if (heartbeatJob != null) return
        heartbeatJob = scope.launch {
            var lastLocAt = 0L
            var cachedLoc: LocationFix.Snapshot? = null
            while (true) {
                try {
                    if (auth.isEnrolled()) {
                        val s = collector.snapshot()
                        val now = System.currentTimeMillis()
                        if (cachedLoc == null || now - lastLocAt > LOCATION_REFRESH_MS) {
                            val fresh = runCatching { locator.get(timeoutMs = 5_000L) }.getOrNull()
                            if (fresh != null) { cachedLoc = fresh; lastLocAt = now }
                        }
                        // Report current privilege level every heartbeat so the
                        // admin UI tracks owner/admin/none transitions live —
                        // e.g. an enrolled-only install promoted to Device Owner
                        // flips in the dashboard within a heartbeat, no manual
                        // FETCH_DEVICE_INFO needed.
                        val mgmtMode = when {
                            dpm.isDeviceOwner() -> "owner"
                            dpm.isAdminActive() -> "admin"
                            else                -> "none"
                        }
                        api.postHeartbeat(HeartbeatDto(
                            battery = s.batteryPct.takeIf { it >= 0 },
                            charging = s.charging,
                            network = s.network,
                            vpnActive = s.vpnActive,
                            appliedPolicyVersion = null,
                            latitude  = cachedLoc?.latitude,
                            longitude = cachedLoc?.longitude,
                            locationAccuracyM = cachedLoc?.accuracyM,
                            ipAddress = s.ipAddress,
                            macAddress = s.macAddress,
                            storageFreeBytes = s.storageFreeBytes.takeIf { it >= 0 },
                            wifiSsid = s.ssid,
                            mgmtMode = mgmtMode
                        ))
                    }
                } catch (t: Throwable) {
                    Timber.v(t, "fast heartbeat iteration failed (non-fatal)")
                }
                delay(HEARTBEAT_MS)
            }
        }
    }

    private fun wireMqtt() {
        val host = tokens.mqttHost().orEmpty()
        val topic = tokens.mqttTopic().orEmpty()
        val device = auth.deviceId().orEmpty()
        val access = auth.accessToken().orEmpty()
        if (host.isBlank() || topic.isBlank() || device.isBlank() || access.isBlank()) {
            Timber.w("MQTT params not yet ready"); return
        }
        // Default to tcp:// since the dev broker (mosquitto in compose) listens
        // plaintext on 1883. Production should override with ssl:// + cert pinning.
        val broker = if (host.startsWith("ssl://") || host.startsWith("tcp://")) host
                     else "tcp://$host:${tokens.mqttPort()}"
        mqtt.connect(
            broker = broker,
            clientId = device,
            username = device,
            password = access,
            subscribeTopic = topic
        )
        scope.launch {
            // IMPORTANT: collect, NOT collectLatest. Each command must run to
            // completion — including the POST /commands/{id}/result inside
            // executor.execute(). With collectLatest a second command arriving
            // mid-flight would cancel the first command's result-POST, making
            // it look on the server like the command was never acked
            // (state stuck on "dispatched" until it timed out) even though the
            // device-side side-effect (camera capture, install, policy apply)
            // had actually run.
            mqtt.messages().collect { msg ->
                runCatching {
                    val cmd = commandAdapter.fromJson(String(msg.bytes, Charsets.UTF_8))
                        ?: return@runCatching
                    executor.execute(cmd)
                }.onFailure { Timber.w(it, "MQTT message handling failed") }
            }
        }
    }

    private fun startPollLoop() {
        if (pollJob != null) return
        pollJob = scope.launch {
            // Fallback HTTP poll. Backs off when MQTT is healthy.
            while (true) {
                val delayMs = if (mqtt.isConnected()) POLL_HEALTHY_MS else POLL_DEGRADED_MS
                delay(delayMs)
                if (!auth.isEnrolled()) continue
                runCatching {
                    val resp = api.pollCommands()
                    val body = resp.body() ?: return@runCatching
                    body.commands.forEach { executor.execute(it) }
                }.onFailure { Timber.v(it, "poll fell over (non-fatal)") }
            }
        }
    }

    private fun startForegroundSafely() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "CyberSentinel MDM",
                NotificationManager.IMPORTANCE_MIN).apply {
                description = "Keeps CyberSentinel MDM connected"
                setShowBadge(false)
            }
            nm.createNotificationChannel(ch)
        }
        val notif: Notification = androidx.core.app.NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle("CyberSentinel MDM")
            .setContentText("Device managed by Virtual Galaxy Infotech Ltd")
            .setOngoing(true)
            .setPriority(androidx.core.app.NotificationCompat.PRIORITY_MIN)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+ rejects startForeground for a camera/microphone/
            // location FGS type unless the matching runtime permission is held
            // RIGHT NOW. In Device Owner mode they're auto-granted; in Device
            // Admin / enrolled-only mode they may not be yet — so we must only
            // declare the types we currently hold, or the service crashes on
            // start (which would break enrolled-only mode entirely). DATA_SYNC
            // is always safe and keeps the heartbeat/command channel alive; the
            // sensor types get added on a later (re)start once the user grants
            // the permission via the in-app Permissions panel.
            var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            if (hasPerm(android.Manifest.permission.CAMERA)) {
                types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            }
            if (hasPerm(android.Manifest.permission.RECORD_AUDIO)) {
                types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            }
            if (hasPerm(android.Manifest.permission.ACCESS_FINE_LOCATION) ||
                hasPerm(android.Manifest.permission.ACCESS_COARSE_LOCATION)) {
                types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            }
            startForeground(NOTIF_ID, notif, types)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun hasPerm(permission: String): Boolean =
        checkSelfPermission(permission) == android.content.pm.PackageManager.PERMISSION_GRANTED

    companion object {
        private const val CHANNEL_ID = "mdm_agent"
        private const val NOTIF_ID = 0xCAFE
        private const val POLL_HEALTHY_MS = 5 * 60_000L
        private const val POLL_DEGRADED_MS = 30_000L
        private const val HEARTBEAT_MS = 60_000L
        private const val LOCATION_REFRESH_MS = 5 * 60_000L

        fun start(ctx: Context) {
            val intent = Intent(ctx, CommandService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent)
            else ctx.startService(intent)
        }
    }
}
