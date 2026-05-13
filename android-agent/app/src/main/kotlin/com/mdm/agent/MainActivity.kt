package com.mdm.agent

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.mdm.agent.ui.EnrollmentScreen
import com.mdm.agent.ui.HomeScreen
import com.mdm.agent.ui.MainViewModel
import dagger.hilt.android.AndroidEntryPoint
import androidx.activity.viewModels

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    private val vm: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(Modifier.fillMaxSize()) {
                    val state by vm.state.collectAsStateWithLifecycle()
                    when (state) {
                        MainViewModel.UiState.NotDeviceOwner -> NotDeviceOwnerNotice()
                        MainViewModel.UiState.NotEnrolled    -> EnrollmentScreen(vm)
                        is MainViewModel.UiState.Enrolled    -> HomeScreen(vm)
                    }
                }
            }
        }
    }
}

@androidx.compose.runtime.Composable
private fun NotDeviceOwnerNotice() {
    Column(Modifier.padding(24.dp)) {
        Text("CyberSentinel MDM", style = MaterialTheme.typography.titleLarge)
        Text("Virtual Galaxy Infotech Ltd",
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(top = 2.dp))
        Text("Agent needs an admin role",
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(top = 16.dp))
        Text(
            "PRODUCTION (full features — factory-reset required):\n" +
            "  adb shell dpm set-device-owner \\\n" +
            "    com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver\n\n" +
            "TEST MODE (Device Admin only — no reset needed):\n" +
            "  adb shell dpm set-active-admin \\\n" +
            "    com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver\n\n" +
            "Test mode supports lock, password policy, wipe, camera & " +
            "screen-capture disable. DO-only ops (silent install, " +
            "restrictions, VPN, proxy) gracefully no-op.",
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(top = 12.dp)
        )
    }
}
