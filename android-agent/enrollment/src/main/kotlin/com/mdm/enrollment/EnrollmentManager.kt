package com.mdm.enrollment

import android.content.Context
import android.os.Build
import com.mdm.networking.api.EnrollRequest
import com.mdm.networking.api.MdmApi
import com.mdm.networking.auth.TokenStore
import com.mdm.security.IntegrityChecker
import dagger.hilt.android.qualifiers.ApplicationContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Single-shot enrollment orchestrator. Caller hands in a server URL + token
 * (either typed manually or recovered from the DPC ProvisioningStash) and we:
 *   1. set the server URL in [TokenStore] so the BaseUrlInterceptor routes
 *      subsequent calls to the right environment;
 *   2. POST /api/v1/devices/enroll with the device fingerprint + integrity;
 *   3. persist the returned credentials so AuthRepository / MqttClient pick
 *      them up immediately;
 *   4. return a stable [Result] for the UI / first-boot path to branch on.
 *
 * Concurrent invocations are NOT supported — enroll once per device per
 * factory lifetime. If you need to re-enroll (e.g. tenant migration), wipe
 * the device and re-provision.
 */
@Singleton
class EnrollmentManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val api: MdmApi,
    private val tokens: TokenStore,
    private val integrity: IntegrityChecker
) {

    suspend fun enroll(serverUrl: String, token: String): Outcome = withContext(Dispatchers.IO) {
        require(serverUrl.startsWith("http")) { "serverUrl must be http(s)" }
        require(token.isNotBlank()) { "enrollment token is required" }

        // Persist server URL first so the OkHttp BaseUrlInterceptor routes to it.
        // We save the full enrollment record only after the API call succeeds —
        // saving an empty deviceId here would make MainViewModel show the
        // home screen for a half-enrolled device.
        tokens.setServerUrl(serverUrl.trimEnd('/'))

        val report = integrity.snapshot()
        val req = EnrollRequest(
            token = token,
            serialNumber = safeSerial(),
            manufacturer = Build.MANUFACTURER,
            model = Build.MODEL,
            osVersion = report.androidVersion,
            securityPatchLevel = report.patchLevel
        )

        val resp = runCatching { api.enroll(req) }
            .onFailure { Timber.e(it, "enroll network failure") }
            .getOrElse { return@withContext Outcome.NetworkError(it.message) }

        val body = resp.body()
        if (!resp.isSuccessful || body == null) {
            val msg = resp.errorBody()?.string().orEmpty()
            Timber.w("enroll non-success: ${resp.code()} $msg")
            return@withContext Outcome.ServerError(resp.code(), msg)
        }

        // MQTT broker isn't part of the EnrollResponse wire format — we
        // reuse the API host with the broker's standard port.
        val brokerHost = serverUrl.trimEnd('/').toHttpUrlOrNull()?.host ?: "localhost"
        tokens.saveEnrollment(TokenStore.Enrollment(
            serverUrl = serverUrl.trimEnd('/'),
            deviceId = body.deviceId,
            tenantId = body.tenantId,
            accessToken = body.accessToken,
            refreshToken = body.refreshToken,
            accessExpiresEpochS = (System.currentTimeMillis() / 1000) + DEFAULT_ACCESS_LIFE_S,
            mqttHost = brokerHost,
            mqttPort = DEFAULT_MQTT_PORT,
            mqttTopic = body.mqttTopic
        ))
        Timber.i("enrolled device=${body.deviceId} tenant=${body.tenantId}")
        Outcome.Success(body.deviceId, body.tenantId)
    }

    @Suppress("DEPRECATION", "HardwareIds")
    private fun safeSerial(): String = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Build.getSerial()
        else Build.SERIAL
    } catch (_: SecurityException) { "unknown" }

    sealed interface Outcome {
        data class Success(val deviceId: String, val tenantId: String) : Outcome
        data class ServerError(val code: Int, val message: String) : Outcome
        data class NetworkError(val message: String?) : Outcome
    }

    private companion object {
        const val DEFAULT_ACCESS_LIFE_S = 3600L
        const val DEFAULT_MQTT_PORT = 1883
    }
}
