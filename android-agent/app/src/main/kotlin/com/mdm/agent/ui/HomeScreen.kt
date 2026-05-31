package com.mdm.agent.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun HomeScreen(vm: MainViewModel) {
    val state by vm.state.collectAsState()
    val ds = state as? MainViewModel.UiState.Enrolled
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp)) {
        Text("CyberSentinel MDM", style = MaterialTheme.typography.headlineSmall)
        Text("Virtual Galaxy Infotech Ltd", style = MaterialTheme.typography.labelSmall)
        Spacer(Modifier.height(16.dp))
        Text("Device ID: ${ds?.deviceId ?: "—"}")
        Text("Status: connected", style = MaterialTheme.typography.bodyMedium)
        val mode = when {
            ds?.deviceOwner == true -> "Device Owner (full control)"
            ds?.adminActive == true -> "Device Admin (limited)"
            else                    -> "Enrolled only (no admin)"
        }
        Text("Mode: $mode", style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(20.dp))
        Text(
            "This device is managed by CyberSentinel MDM. Policy and commands " +
            "sync in the background.",
            style = MaterialTheme.typography.bodySmall
        )
        // When not a Device Owner, explain (don't block) how to unlock more.
        if (ds?.deviceOwner != true) {
            Spacer(Modifier.height(12.dp))
            Text("Unlock more control (optional)", style = MaterialTheme.typography.titleSmall)
            Text(
                "This device works in its current mode (read-only telemetry + any " +
                "permissions you grant below). For lock/wipe/password control, make " +
                "the app a Device Admin; for full management (silent install, " +
                "restrictions, VPN, auto-granted camera/mic), provision it as Device " +
                "Owner on a freshly reset device:\n\n" +
                "  Device Admin:  adb shell dpm set-active-admin \\\n" +
                "    com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver\n" +
                "  Device Owner:  adb shell dpm set-device-owner \\\n" +
                "    com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver",
                style = MaterialTheme.typography.bodySmall
            )
        }
        // Grant the permissions the agent needs. Essential in Device Admin /
        // non-owner modes where nothing is auto-granted; in Device Owner mode it
        // only surfaces the usage-access toggle no app can grant programmatically.
        PermissionsPanel(deviceOwner = ds?.deviceOwner == true)
    }
}
