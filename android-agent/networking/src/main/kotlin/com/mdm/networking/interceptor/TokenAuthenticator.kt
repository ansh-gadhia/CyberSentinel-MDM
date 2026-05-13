package com.mdm.networking.interceptor

import com.mdm.networking.auth.AuthRepository
import kotlinx.coroutines.runBlocking
import okhttp3.Authenticator
import okhttp3.Request
import okhttp3.Response
import okhttp3.Route

/**
 * OkHttp authenticator hook fired when the server returns 401. We attempt
 * exactly one refresh and replay; if that fails or the request has already
 * been replayed, we give up and let the 401 bubble to the caller.
 *
 * Coexists with [TokenInterceptor]: the interceptor handles proactive refresh
 * before the call goes out; the authenticator handles reactive refresh for the
 * narrow window between "token still valid by clock" and "server rejects it"
 * (e.g. JWT key rotation).
 */
class TokenAuthenticator(
    private val auth: AuthRepository
) : Authenticator {

    override fun authenticate(route: Route?, response: Response): Request? {
        if (responseCount(response) >= 2) return null  // already retried
        val newToken = runBlocking { auth.refreshNow() } ?: return null
        return response.request.newBuilder()
            .header("Authorization", "Bearer $newToken")
            .build()
    }

    private fun responseCount(response: Response): Int {
        var n = 1
        var r = response.priorResponse
        while (r != null) { n++; r = r.priorResponse }
        return n
    }
}
