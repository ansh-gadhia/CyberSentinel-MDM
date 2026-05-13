package com.mdm.command

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.content.pm.PackageInstaller
import com.mdm.networking.api.MdmApi
import dagger.hilt.android.qualifiers.ApplicationContext
import timber.log.Timber
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Device-Owner-grade APK install via [PackageInstaller] sessions. Skips the
 * UI confirmation dialog that side-loaded installs would normally trigger,
 * because the Device Owner is implicitly trusted as an installer.
 *
 * Download flow:
 *   - The server hands back either a direct `download_url` (typically a
 *     presigned MinIO URL) or a `download_object_id` we resolve via
 *     [MdmApi.presignDownload].
 *   - We stream the bytes directly into the install session — no temp file
 *     on disk, no extra storage permissions needed.
 *
 * Failures bubble up as exceptions so the caller can map them to a typed
 * CommandAckDto.
 */
@Singleton
class AppInstaller @Inject constructor(
    @ApplicationContext private val context: Context,
    private val api: MdmApi
) {

    suspend fun install(
        packageName: String,
        downloadObjectId: String?,
        directUrl: String?
    ) {
        val url = directUrl ?: downloadObjectId?.let { resolveObjectUrl(it) }
        require(url != null) { "no download url for $packageName" }

        val pi = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(packageName)
        }
        val sessionId = pi.createSession(params)
        val session = pi.openSession(sessionId)
        try {
            session.openWrite("apk", 0, -1).use { out ->
                val body = api.downloadRaw(url).body() ?: throw IOException("empty body for $url")
                body.byteStream().use { input ->
                    val buf = ByteArray(64 * 1024); var n: Int
                    while (input.read(buf).also { n = it } != -1) out.write(buf, 0, n)
                }
                session.fsync(out)
            }
            session.commit(silentIntentSender(packageName))
            Timber.i("Install session $sessionId committed for $packageName")
        } catch (t: Throwable) {
            runCatching { session.abandon() }
            throw t
        } finally {
            session.close()
        }
    }

    fun uninstall(packageName: String) {
        val pi = context.packageManager.packageInstaller
        pi.uninstall(packageName, silentIntentSender(packageName))
    }

    private suspend fun resolveObjectUrl(objectId: String): String {
        val resp = api.presignDownload(objectId)
        check(resp.isSuccessful) { "presign ${resp.code()} for $objectId" }
        return resp.body()?.url ?: error("empty presign for $objectId")
    }

    private fun silentIntentSender(packageName: String): IntentSender {
        val intent = Intent("com.mdm.PACKAGE_INSTALL_RESULT").setPackage(context.packageName)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        return PendingIntent.getBroadcast(context, packageName.hashCode(), intent, flags).intentSender
    }
}
