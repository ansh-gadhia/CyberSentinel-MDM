package com.mdm.command

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.IntentSender
import android.content.pm.PackageInstaller
import android.os.Build
import com.mdm.networking.api.MdmApi
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import timber.log.Timber
import java.io.IOException
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

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
 * Failure surfacing: [install] does NOT return until PackageInstaller has
 * broadcast a final status. STATUS_FAILURE_* turn into IOException carrying
 * the system's EXTRA_STATUS_MESSAGE — the calling command result therefore
 * carries a real error string instead of a false "succeeded".
 */
@Singleton
class AppInstaller @Inject constructor(
    @ApplicationContext private val context: Context,
    private val api: MdmApi
) {

    suspend fun install(
        packageName: String?,
        downloadObjectId: String?,
        directUrl: String?
    ) {
        val initialUrl = directUrl ?: downloadObjectId?.let { resolveObjectUrl(it) }
        requireNotNull(initialUrl) { "no download url provided" }

        // Open the response stream first (with one transparent re-presign
        // retry on stale-URL/transient failures), then open the
        // PackageInstaller session and stream straight through — avoids
        // holding a multi-hundred-MB APK in heap memory.
        val body = openDownload(initialUrl, downloadObjectId)
        val expectedBytes = body.contentLength()

        val pi = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            if (!packageName.isNullOrBlank() && packageName.contains('.')) {
                setAppPackageName(packageName)
            }
            if (expectedBytes > 0) setSize(expectedBytes)
        }
        val sessionId = pi.createSession(params)
        val session = pi.openSession(sessionId)
        val streamed = try {
            session.openWrite("apk", 0, if (expectedBytes > 0) expectedBytes else -1).use { out ->
                var total = 0L
                body.byteStream().use { input ->
                    val buf = ByteArray(64 * 1024); var n: Int
                    while (input.read(buf).also { n = it } != -1) { out.write(buf, 0, n); total += n }
                }
                session.fsync(out)
                total
            }
        } catch (t: Throwable) {
            runCatching { session.abandon() }
            session.close()
            throw t
        }
        Timber.i("Install session $sessionId bytes=$streamed pkg=${packageName ?: "(auto)"}")

        try {
            awaitInstallResult(session, sessionId, packageName)
        } finally {
            session.close()
        }
    }

    suspend fun uninstall(packageName: String) {
        val pi = context.packageManager.packageInstaller
        val action = "com.mdm.PACKAGE_UNINSTALL_RESULT.${UUID.randomUUID()}"
        awaitWithReceiver(action, label = "uninstall($packageName)") { sender ->
            pi.uninstall(packageName, sender)
        }
    }

    /**
     * Commits [session] and suspends until PackageInstaller broadcasts a
     * final status. STATUS_PENDING_USER_ACTION (Device Admin mode without
     * silent install permission) is relayed as a system "Install this app?"
     * dialog; we keep waiting for the SUCCESS/FAILURE that follows.
     */
    private suspend fun awaitInstallResult(
        session: PackageInstaller.Session,
        sessionId: Int,
        packageName: String?
    ) {
        val action = "com.mdm.PACKAGE_INSTALL_RESULT.${UUID.randomUUID()}"
        awaitWithReceiver(action, label = "install($sessionId,${packageName ?: "auto"})") { sender ->
            session.commit(sender)
        }
    }

    private suspend fun awaitWithReceiver(
        action: String,
        label: String,
        trigger: (IntentSender) -> Unit
    ) {
        try {
            withTimeout(INSTALL_TIMEOUT_MS) {
                suspendCancellableCoroutine<Unit> { cont ->
                    val receiver = object : BroadcastReceiver() {
                        override fun onReceive(ctx: Context, intent: Intent) {
                            val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999)
                            val pkg = intent.getStringExtra(PackageInstaller.EXTRA_PACKAGE_NAME) ?: "?"
                            val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                            when (status) {
                                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                                    val launch = if (Build.VERSION.SDK_INT >= 33) {
                                        intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                                    } else {
                                        @Suppress("DEPRECATION")
                                        intent.getParcelableExtra(Intent.EXTRA_INTENT)
                                    }
                                    if (launch != null) {
                                        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                        runCatching { ctx.startActivity(launch) }
                                            .onFailure { Timber.w(it, "$label launch prompt failed") }
                                        Timber.i("$label awaiting on-device user approval")
                                    } else {
                                        Timber.w("$label PENDING_USER_ACTION but no EXTRA_INTENT")
                                    }
                                    // Keep listening — a final SUCCESS/FAILURE
                                    // arrives after the user taps Install.
                                }
                                PackageInstaller.STATUS_SUCCESS -> {
                                    Timber.i("$label succeeded ($pkg)")
                                    runCatching { ctx.unregisterReceiver(this) }
                                    if (cont.isActive) cont.resume(Unit)
                                }
                                else -> {
                                    Timber.w("$label failed status=$status msg=$msg")
                                    runCatching { ctx.unregisterReceiver(this) }
                                    if (cont.isActive) cont.resumeWithException(
                                        IOException("install failed (status=$status${msg?.let { ": $it" } ?: ""})")
                                    )
                                }
                            }
                        }
                    }
                    val filter = IntentFilter(action)
                    if (Build.VERSION.SDK_INT >= 33) {
                        context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
                    } else {
                        @Suppress("UnspecifiedRegisterReceiverFlag")
                        context.registerReceiver(receiver, filter)
                    }
                    cont.invokeOnCancellation {
                        runCatching { context.unregisterReceiver(receiver) }
                    }
                    val statusIntent = Intent(action).setPackage(context.packageName)
                    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
                    val pending = PendingIntent.getBroadcast(
                        context, action.hashCode(), statusIntent, flags
                    )
                    trigger(pending.intentSender)
                }
            }
        } catch (e: TimeoutCancellationException) {
            throw IOException("$label timed out after ${INSTALL_TIMEOUT_MS / 1000}s waiting for PackageInstaller")
        }
    }

    private suspend fun resolveObjectUrl(objectId: String): String {
        val resp = api.presignDownload(objectId)
        check(resp.isSuccessful) { "presign ${resp.code()} for $objectId" }
        return resp.body()?.url ?: error("empty presign for $objectId")
    }

    /**
     * Opens the APK byte stream behind [initialUrl]. Tries once; if MinIO
     * responds with a retryable status (403 — usually a stale signature; 408
     * timeout; 5xx server error) and we have an [objectId] we can re-presign
     * against, it transparently mints a fresh URL and tries one more time. On
     * final failure the IOException message carries the real HTTP status and
     * a snippet of MinIO's XML error body, so the recorded command result is
     * actually diagnosable (vs the previous "empty body" carrying no signal).
     */
    private suspend fun openDownload(initialUrl: String, objectId: String?): okhttp3.ResponseBody {
        var url = initialUrl
        var retried = false
        while (true) {
            val resp = api.downloadRaw(url)
            val b = resp.body()
            if (resp.isSuccessful && b != null) return b
            val code = resp.code()
            val errSnippet = runCatching { resp.errorBody()?.string()?.take(512) }.getOrNull()
            val msg = "download failed http=$code body=${errSnippet ?: "<empty>"} url=$url"
            val retryable = code == 403 || code == 400 || code == 408 || code in 500..599
            if (!retried && retryable && objectId != null) {
                Timber.w("$msg — retrying with fresh presign")
                url = resolveObjectUrl(objectId)
                retried = true
                continue
            }
            throw IOException(msg)
        }
    }

    private companion object {
        // Generous — OS verifies + applies the APK, can stretch on older
        // devices. Caller's command timeout (10m default) bounds this anyway.
        const val INSTALL_TIMEOUT_MS = 5L * 60_000L
    }
}
