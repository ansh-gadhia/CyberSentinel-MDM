package com.mdm.networking.interceptor

import com.mdm.networking.auth.AuthRepository
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.Request
import okhttp3.Response

/**
 * Adds `Authorization: Bearer <token>` to every request except enroll/refresh,
 * which the server treats as unauthenticated entry points.
 *
 * Refresh-on-expiry happens here proactively. Refresh-on-401 happens in
 * [TokenAuthenticator] which OkHttp wires into the retry path.
 */
class TokenInterceptor(
    private val auth: AuthRepository
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        if (isUnauthRoute(req)) return chain.proceed(req)

        val token = runBlocking { auth.ensureAccessToken() }
        val newReq: Request = if (token.isNullOrEmpty()) req
        else req.newBuilder().header("Authorization", "Bearer $token").build()
        return chain.proceed(newReq)
    }

    private fun isUnauthRoute(req: Request): Boolean {
        val path = req.url.encodedPath
        return path == "/api/v1/enroll/" || path == "/api/v1/enroll"
            || path.endsWith("/api/v1/auth/refresh")
    }
}
