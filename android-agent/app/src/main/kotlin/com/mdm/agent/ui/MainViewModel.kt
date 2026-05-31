package com.mdm.agent.ui

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mdm.command.CommandService
import com.mdm.core.admin.DevicePolicyController
import com.mdm.enrollment.EnrollmentManager
import com.mdm.networking.auth.AuthRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Decides which screen to render. Admin/owner rights are NOT required to use the
 * app: a device can enroll with no admin role at all ("enrolled-only" mode —
 * read-only telemetry + whatever permissions the user grants). Device Admin and
 * Device Owner are optional capability upgrades surfaced on the home screen, not
 * gates. The only thing needed to leave the enrollment screen is valid device
 * credentials.
 */
@HiltViewModel
class MainViewModel @Inject constructor(
    @ApplicationContext private val appContext: Context,
    private val dpm: DevicePolicyController,
    private val enrollment: EnrollmentManager,
    private val auth: AuthRepository
) : ViewModel() {

    sealed interface UiState {
        data object NotEnrolled : UiState
        data class  Enrolled(val deviceId: String, val deviceOwner: Boolean, val adminActive: Boolean) : UiState
    }

    private val _state = MutableStateFlow<UiState>(compute())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    fun refresh() {
        val s = compute()
        _state.value = s
        // Once enrolled — in ANY mode, including no-admin — bring up the command
        // channel / heartbeat so the device reports in (mgmt_mode "none") and
        // can receive commands its mode permits. Idempotent.
        if (s is UiState.Enrolled) CommandService.start(appContext)
    }

    fun enroll(serverUrl: String, token: String) {
        _busy.value = true; _error.value = null
        viewModelScope.launch {
            val res = runCatching { enrollment.enroll(serverUrl, token) }
            res.onSuccess { outcome ->
                when (outcome) {
                    is com.mdm.enrollment.EnrollmentManager.Outcome.Success -> refresh()
                    is com.mdm.enrollment.EnrollmentManager.Outcome.NetworkError ->
                        _error.value = "Network error: ${outcome.message ?: "could not reach server"}. " +
                                       "Check the URL and that the phone can reach it."
                    is com.mdm.enrollment.EnrollmentManager.Outcome.ServerError ->
                        _error.value = "Server rejected enrollment (HTTP ${outcome.code}). " +
                                       (outcome.message.takeIf { it.isNotBlank() } ?: "Check the token.")
                }
            }
            res.onFailure { _error.value = "Unexpected: ${it.message ?: it::class.java.simpleName}" }
            _busy.value = false
        }
    }

    private fun compute(): UiState {
        // No admin gate — enrollment is allowed with no admin role. Admin/owner
        // status is reported alongside so the home screen can show the mode and
        // offer optional elevation.
        val deviceId = auth.deviceId()
        if (deviceId.isNullOrBlank()) return UiState.NotEnrolled
        return UiState.Enrolled(
            deviceId,
            deviceOwner = dpm.isDeviceOwner(),
            adminActive = dpm.isAdminActive()
        )
    }
}
