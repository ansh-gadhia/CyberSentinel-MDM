package com.mdm.networking.auth

import com.mdm.networking.api.MdmApi
import com.mdm.networking.api.RefreshRequest
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Owns the agent's credential lifecycle:
 *  - exposes the device identity to the UI/services;
 *  - rotates the access token via /auth/refresh with single-flight semantics
 *    so we don't burn refresh tokens in a thundering herd.
 *
 * NOTE: [refreshIfNeeded] is also the single re-entry point invoked from the
 * 401-retry path in [com.mdm.networking.interceptor.TokenAuthenticator] —
 * keep it side-effect-free aside from the TokenStore update.
 */
@Singleton
class AuthRepository @Inject constructor(
    private val tokens: TokenStore,
    private val apiHolder: dagger.Lazy<MdmApi>  // break circular dep: api needs interceptor needs us
) {
    private val refreshMutex = Mutex()

    fun deviceId(): String? = tokens.deviceId()
    fun tenantId(): String? = tokens.tenantId()
    fun serverUrl(): String? = tokens.serverUrl()
    fun accessToken(): String? = tokens.accessToken()
    fun isEnrolled(): Boolean = tokens.isEnrolled()

    /**
     * Returns the current access token, refreshing it first if it expires
     * within [refreshSkewSeconds]. Thread-safe; only one network call in
     * flight even if N callers race in.
     */
    suspend fun ensureAccessToken(refreshSkewSeconds: Long = 60): String? {
        val now = System.currentTimeMillis() / 1000
        val exp = tokens.accessExpiresEpochS()
        if (exp == 0L || exp > now + refreshSkewSeconds) {
            return tokens.accessToken()
        }
        return refreshNow()
    }

    /** Force a refresh — used by the 401 retry. */
    suspend fun refreshNow(): String? = refreshMutex.withLock {
        // Re-check under lock — another coroutine may have just refreshed.
        val now = System.currentTimeMillis() / 1000
        if (tokens.accessExpiresEpochS() > now + 30) {
            return@withLock tokens.accessToken()
        }
        val rt = tokens.refreshToken() ?: return@withLock null
        val resp = runCatching { apiHolder.get().refresh(RefreshRequest(rt)) }
            .onFailure { Timber.w(it, "refresh failed") }
            .getOrNull() ?: return@withLock null
        val body = resp.body()
        if (!resp.isSuccessful || body == null) {
            Timber.w("refresh non-success: ${resp.code()}")
            // 401 here means the refresh token itself is dead — force re-enroll.
            if (resp.code() == 401) tokens.clear()
            return@withLock null
        }
        tokens.updateTokens(
            access = body.accessToken,
            refresh = body.refreshToken,
            expEpochS = (System.currentTimeMillis() / 1000) + body.expiresIn
        )
        body.accessToken
    }

    fun clear() = tokens.clear()
}
