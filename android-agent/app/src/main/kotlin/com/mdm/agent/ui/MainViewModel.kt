package com.mdm.agent.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mdm.core.admin.DevicePolicyController
import com.mdm.enrollment.EnrollmentManager
import com.mdm.networking.auth.AuthRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Decides which screen to render based on:
 *   1) Are we Device Owner?
 *   2) If so, do we have stored device credentials?
 */
@HiltViewModel
class MainViewModel @Inject constructor(
    private val dpm: DevicePolicyController,
    private val enrollment: EnrollmentManager,
    private val auth: AuthRepository
) : ViewModel() {

    sealed interface UiState {
        data object NotDeviceOwner : UiState
        data object NotEnrolled    : UiState
        data class  Enrolled(val deviceId: String, val deviceOwner: Boolean) : UiState
    }

    private val _state = MutableStateFlow<UiState>(compute())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    fun refresh() { _state.value = compute() }

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
        // Allow both Device Owner (full power) and Device Admin (test mode,
        // a subset of policies). The UI flags DA-mode separately.
        if (!dpm.isAdminActive()) return UiState.NotDeviceOwner
        val deviceId = auth.deviceId()
        if (deviceId.isNullOrBlank()) return UiState.NotEnrolled
        return UiState.Enrolled(deviceId, deviceOwner = dpm.isDeviceOwner())
    }
}
