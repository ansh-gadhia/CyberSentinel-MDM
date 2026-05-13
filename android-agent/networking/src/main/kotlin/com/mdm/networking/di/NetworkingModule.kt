package com.mdm.networking.di

import com.mdm.networking.BuildConfig
import com.mdm.networking.api.MdmApi
import com.mdm.networking.auth.AuthRepository
import com.mdm.networking.auth.TokenStore
import com.mdm.networking.interceptor.TokenAuthenticator
import com.mdm.networking.interceptor.TokenInterceptor
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory
import java.util.concurrent.TimeUnit
import javax.inject.Singleton

/**
 * Wires up everything the agent needs to talk HTTP / MQTT to the MDM server.
 *
 * Base URL resolution order (first non-null wins):
 *   1. [TokenStore.serverUrl] — set during enrollment
 *   2. BuildConfig.DEFAULT_SERVER_URL — compiled-in fallback
 *
 * We use a custom HttpUrl interceptor for (1) so the same Retrofit instance
 * can survive a re-enrollment without a process restart.
 */
@Module
@InstallIn(SingletonComponent::class)
object NetworkingModule {

    @Provides @Singleton
    fun provideMoshi(): Moshi = Moshi.Builder()
        .add(KotlinJsonAdapterFactory())
        .build()

    // AuthRepository is @Inject constructor — Hilt builds it directly. We
    // intentionally do NOT declare a @Provides for it here, because that
    // would create a duplicate binding.

    @Provides @Singleton
    fun provideOkHttp(
        auth: AuthRepository,
        tokens: TokenStore
    ): OkHttpClient {
        val logging = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) HttpLoggingInterceptor.Level.BODY
                    else HttpLoggingInterceptor.Level.NONE
        }
        return OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .addInterceptor(BaseUrlInterceptor(tokens))
            .addInterceptor(TokenInterceptor(auth))
            .authenticator(TokenAuthenticator(auth))
            .addInterceptor(logging)
            .build()
    }

    @Provides @Singleton
    fun provideRetrofit(client: OkHttpClient, moshi: Moshi): Retrofit =
        Retrofit.Builder()
            .baseUrl(BuildConfig.DEFAULT_SERVER_URL.trimEnd('/') + "/")
            .client(client)
            .addConverterFactory(MoshiConverterFactory.create(moshi))
            .build()

    @Provides @Singleton
    fun provideApi(retrofit: Retrofit): MdmApi = retrofit.create(MdmApi::class.java)
}

/**
 * Swaps the request's host with [TokenStore.serverUrl] if set, so we can
 * compile the APK once and let enrollment point it at any environment.
 */
private class BaseUrlInterceptor(
    private val tokens: TokenStore
) : okhttp3.Interceptor {
    override fun intercept(chain: okhttp3.Interceptor.Chain): okhttp3.Response {
        val configured = tokens.serverUrl()
        if (configured.isNullOrBlank()) return chain.proceed(chain.request())
        val configuredHttp = runCatching {
            configured.trimEnd('/').toHttpUrl()
        }.getOrElse { return chain.proceed(chain.request()) }
        val origin = chain.request().url
        val patched = origin.newBuilder()
            .scheme(configuredHttp.scheme)
            .host(configuredHttp.host)
            .port(configuredHttp.port)
            .build()
        return chain.proceed(chain.request().newBuilder().url(patched).build())
    }
}
