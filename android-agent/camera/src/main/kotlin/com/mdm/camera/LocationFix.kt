package com.mdm.camera

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Looper
import androidx.core.content.ContextCompat
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Single-fix location helper. Returns the last-known fix immediately and
 * piggy-backs a single fresh fix request with a short timeout. Used for
 * asset-recovery (photo + GPS) and "find device" flows.
 */
@Singleton
class LocationFix @Inject constructor(
    @ApplicationContext private val context: Context
) {

    data class Snapshot(
        val latitude: Double, val longitude: Double, val accuracyM: Float,
        val provider: String, val timestamp: Long, val isFresh: Boolean
    )

    private val lm: LocationManager? =
        context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager

    @SuppressLint("MissingPermission")
    suspend fun get(timeoutMs: Long = 8_000L): Snapshot? {
        if (lm == null) return null
        if (!hasPermission()) {
            Timber.w("LocationFix: ACCESS_*_LOCATION not granted")
            return null
        }
        val mgr = lm
        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER,
                               LocationManager.PASSIVE_PROVIDER)
            .filter { runCatching { mgr.isProviderEnabled(it) }.getOrDefault(false) }

        val lastKnown: Location? = providers
            .mapNotNull { runCatching { mgr.getLastKnownLocation(it) }.getOrNull() }
            .maxByOrNull { it.time }

        val fresh = withTimeoutOrNull(timeoutMs) {
            val def = CompletableDeferred<Location?>()
            val listener = android.location.LocationListener { loc -> def.complete(loc) }
            val target = providers.firstOrNull { it == LocationManager.GPS_PROVIDER }
                ?: providers.firstOrNull() ?: return@withTimeoutOrNull null
            try {
                mgr.requestSingleUpdate(target, listener, Looper.getMainLooper())
            } catch (t: Throwable) {
                Timber.w(t, "requestSingleUpdate")
                return@withTimeoutOrNull null
            }
            try { def.await() } finally { runCatching { mgr.removeUpdates(listener) } }
        }
        val pick = fresh ?: lastKnown ?: return null
        return Snapshot(
            latitude  = pick.latitude,
            longitude = pick.longitude,
            accuracyM = pick.accuracy,
            provider  = pick.provider ?: "?",
            timestamp = pick.time,
            isFresh   = fresh != null
        )
    }

    private fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
}
