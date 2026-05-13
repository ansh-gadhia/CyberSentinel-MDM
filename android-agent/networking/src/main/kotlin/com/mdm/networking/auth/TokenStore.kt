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
    }
}
