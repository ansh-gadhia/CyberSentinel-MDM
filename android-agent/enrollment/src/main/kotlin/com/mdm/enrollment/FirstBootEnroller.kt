package com.mdm.enrollment

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import androidx.hilt.work.HiltWorker
import com.mdm.core.admin.ProvisioningStash
import com.mdm.networking.auth.TokenStore
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import timber.log.Timber

/**
 * Runs once on first boot after DPC provisioning. Reads the
 * [ProvisioningStash] (populated by
 * [com.mdm.core.admin.MDMDeviceAdminReceiver.onProfileProvisioningComplete])
 * and finishes enrollment via the network. Idempotent: re-runs are no-ops
 * once [TokenStore.isEnrolled] returns true.
 *
 * Enqueued by [com.mdm.command.CommandService] on its first start; if the
 * service starts before the stash has been written (race window during very
 * fast provisioning) it'll just retry on the next boot.
 */
@HiltWorker
class FirstBootEnroller @AssistedInject constructor(
    @Assisted ctx: Context,
    @Assisted params: WorkerParameters,
    private val stash: ProvisioningStash,
    private val tokens: TokenStore,
    private val enrollment: EnrollmentManager
) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        if (tokens.isEnrolled()) {
            Timber.d("FirstBootEnroller: already enrolled, skipping"); return Result.success()
        }
        val (serverUrl, token, _) = stash.read() ?: run {
            Timber.w("FirstBootEnroller: no provisioning stash; manual enrollment required")
            return Result.success()  // not an error — UI flow will pick it up
        }
        return when (val out = enrollment.enroll(serverUrl, token)) {
            is EnrollmentManager.Outcome.Success -> {
                stash.clear(); Result.success()
            }
            is EnrollmentManager.Outcome.NetworkError -> Result.retry()
            is EnrollmentManager.Outcome.ServerError -> {
                // 4xx is permanent (bad token, wrong tenant). 5xx warrants retry.
                if (out.code in 500..599) Result.retry() else Result.failure()
            }
        }
    }
}
