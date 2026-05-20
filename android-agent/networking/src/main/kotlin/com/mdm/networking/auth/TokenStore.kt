package com.mdm.networking.auth

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Persists post-enrollment credentials so the agent can talk to the server on
 * every cold start without re-prompting. Backed by AndroidKeystore — even with
 * root, the access/refresh tokens aren't trivially extractable.
 *
 * Storage layout (all strings):
 *   server_url, device_id, tenant_id,
 *   access_token, refresh_token, access_expires_epoch_s,
 *   mqtt_host, mqtt_port, mqtt_topic
 *
 * Thread-safety: EncryptedSharedPreferences uses commit()/apply() like normal
 * SharedPreferences; concurrent writers may race, but the agent has a single
 * AuthRepository owner so this isn't observed in practice.
 */
@Singleton
class TokenStore @Inject constructor(
    @ApplicationContext context: Context
) {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        FILE,
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    fun saveEnrollment(s: Enrollment) {
        prefs.edit()
            .putString(K_SERVER, s.serverUrl)
            .putString(K_DEVICE, s.deviceId)
            .putString(K_TENANT, s.tenantId)
            .putString(K_ACCESS, s.accessToken)
            .putString(K_REFRESH, s.refreshToken)
            .putLong  (K_ACCESS_EXP, s.accessExpiresEpochS)
            .putString(K_MQTT_HOST, s.mqttHost)
            .putInt   (K_MQTT_PORT, s.mqttPort)
            .putString(K_MQTT_TOPIC, s.mqttTopic)
            .apply()
    }

    /** Persist only the server URL — used before enrollment completes so the
     *  BaseUrlInterceptor can route the upcoming /enroll call to the right host. */
    fun setServerUrl(url: String) {
        prefs.edit().putString(K_SERVER, url).apply()
    }

    fun updateTokens(access: String, refresh: String, expEpochS: Long) {
        prefs.edit()
            .putString(K_ACCESS, access)
            .putString(K_REFRESH, refresh)
            .putLong(K_ACCESS_EXP, expEpochS)
            .apply()
    }

    fun serverUrl(): String? = prefs.getString(K_SERVER, null)
    fun deviceId(): String? = prefs.getString(K_DEVICE, null)
    fun tenantId(): String? = prefs.getString(K_TENANT, null)
    fun accessToken(): String? = prefs.getString(K_ACCESS, null)
    fun refreshToken(): String? = prefs.getString(K_REFRESH, null)
    fun accessExpiresEpochS(): Long = prefs.getLong(K_ACCESS_EXP, 0L)

    fun mqttHost(): String? = prefs.getString(K_MQTT_HOST, null)
    fun mqttPort(): Int = prefs.getInt(K_MQTT_PORT, 1883)
    fun mqttTopic(): String? = prefs.getString(K_MQTT_TOPIC, null)

    fun isEnrolled(): Boolean = deviceId() != null && refreshToken() != null

    // ----- policy-derived flags -----
    // Stored here for convenience (single encrypted prefs file). Set when the
    // PolicyApplier sees the relevant spec field; read by lightweight runtime
    // components (e.g. ActivityMonitor) that don't otherwise need the full
    // PolicyEngine in their dep graph.
    fun setCaptureOnUnlock(enabled: Boolean) {
        prefs.edit().putBoolean(K_CAPTURE_ON_UNLOCK, enabled).apply()
    }
    fun captureOnUnlock(): Boolean = prefs.getBoolean(K_CAPTURE_ON_UNLOCK, false)

    /**
     * The most recent app-blocklist applied (comma-joined package names).
     * Tracked so CLEAR_POLICY can iterate and call setApplicationHidden(false)
     * on each previously-hidden package without us having to remember the
     * history server-side.
     */
    fun setAppBlocklist(packages: List<String>) {
        prefs.edit().putString(K_APP_BLOCKLIST, packages.joinToString(",")).apply()
    }
    fun appBlocklist(): List<String> {
        val raw = prefs.getString(K_APP_BLOCKLIST, "") ?: ""
        return if (raw.isBlank()) emptyList() else raw.split(",").filter { it.isNotBlank() }
    }

    /**
     * Stores the entire PolicySpec JSON that was most recently applied. The
     * PolicyApplier reads this on the next apply() to compute a field-level
     * diff: any setting that was *true/non-null* last time but is null/absent
     * now must be explicitly reset, otherwise null-means-preserve leaves the
     * device stuck with the prior enforcement (e.g. camera permanently
     * disabled after an unassign).
     */
    fun setLastAppliedSpecJson(json: String?) {
        prefs.edit().apply {
            if (json.isNullOrBlank()) remove(K_LAST_APPLIED_SPEC) else putString(K_LAST_APPLIED_SPEC, json)
        }.apply()
    }
    fun lastAppliedSpecJson(): String? = prefs.getString(K_LAST_APPLIED_SPEC, null)

    /**
     * Set of Chrome managed-config URLBlocklist entries from the last applied
     * policy. Used the same way as appBlocklist — so CLEAR_POLICY and removal
     * reconciliation can push an empty list down to every Chromium variant.
     */
    fun setUrlBlocklist(urls: List<String>) {
        prefs.edit().putString(K_URL_BLOCKLIST, urls.joinToString("\n")).apply()
    }
    fun urlBlocklist(): List<String> {
        val raw = prefs.getString(K_URL_BLOCKLIST, "") ?: ""
        return if (raw.isBlank()) emptyList() else raw.split("\n").filter { it.isNotBlank() }
    }

    fun clear() = prefs.edit().clear().apply()

    data class Enrollment(
        val serverUrl: String,
        val deviceId: String,
        val tenantId: String,
        val accessToken: String,
        val refreshToken: String,
        val accessExpiresEpochS: Long,
        val mqttHost: String,
        val mqttPort: Int,
        val mqttTopic: String
    )

    private companion object {
        const val FILE = "mdm_tokens"
        const val K_SERVER = "server_url"
        const val K_DEVICE = "device_id"
        const val K_TENANT = "tenant_id"
        const val K_ACCESS = "access_token"
        const val K_REFRESH = "refresh_token"
        const val K_ACCESS_EXP = "access_exp"
        const val K_MQTT_HOST = "mqtt_host"
        const val K_MQTT_PORT = "mqtt_port"
        const val K_MQTT_TOPIC = "mqtt_topic"
        const val K_CAPTURE_ON_UNLOCK = "capture_on_unlock"
        const val K_APP_BLOCKLIST = "app_blocklist"
        const val K_LAST_APPLIED_SPEC = "last_applied_spec_json"
        const val K_URL_BLOCKLIST = "url_blocklist"
    }
}
