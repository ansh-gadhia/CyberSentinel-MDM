package com.mdm.agent

import android.app.Application
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import com.mdm.command.CommandService
import com.mdm.core.admin.DevicePolicyController
import dagger.hilt.android.HiltAndroidApp
import timber.log.Timber
import javax.inject.Inject

/**
 * Hilt-managed [Application]. We:
 *  - install a [HiltWorkerFactory] so WorkManager can inject our workers;
 *  - start the foreground [CommandService] iff the agent is fully provisioned
 *    (Device Owner + enrolled). If not, the UI flow handles enrollment first.
 */
@HiltAndroidApp
class MDMApplication : Application(), Configuration.Provider {

    @Inject lateinit var workerFactory: HiltWorkerFactory
    @Inject lateinit var dpm: DevicePolicyController

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder().setWorkerFactory(workerFactory).build()

    override fun onCreate() {
        super.onCreate()
        if (BuildConfig.DEBUG) {
            Timber.plant(Timber.DebugTree())
        }
        // Start the command channel whenever any admin role is active.
        // The DPM gating inside individual ops handles DO-vs-DA capability.
        if (dpm.isAdminActive()) {
            CommandService.start(this)
        }
    }
}
