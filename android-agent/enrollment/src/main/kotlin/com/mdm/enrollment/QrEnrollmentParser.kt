package com.mdm.enrollment

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Parses the QR-code payload the admin console issues for new device
 * provisioning. The server emits the same JSON in
 * `enrollment_service.QrPayload` — keep field names locked.
 *
 * Two formats are accepted:
 *   - the agent-format JSON below, used for post-DPC manual enrollment;
 *   - the AOSP-defined `android.app.extra.PROVISIONING_*` bundle, which the
 *     Setup Wizard hands off via the Intent extras — that path is parsed in
 *     [com.mdm.core.admin.MDMDeviceAdminReceiver].
 */
@Serializable
data class QrPayload(
    val server_url: String,
    val enrollment_token: String,
    val tenant_id: String = ""
)

object QrEnrollmentParser {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    fun parse(raw: String): Result<QrPayload> = runCatching {
        json.decodeFromString(QrPayload.serializer(), raw)
    }
}
