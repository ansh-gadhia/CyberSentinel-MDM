package com.mdm.agent.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
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
    Column(Modifier.fillMaxSize().padding(24.dp)) {
        Text("CyberSentinel MDM", style = MaterialTheme.typography.headlineSmall)
        Text("Virtual Galaxy Infotech Ltd", style = MaterialTheme.typography.labelSmall)
        Spacer(Modifier.height(16.dp))
        Text("Device ID: ${ds?.deviceId ?: "—"}")
        Text("Status: connected", style = MaterialTheme.typography.bodyMedium)
        val mode = if (ds?.deviceOwner == true) "Device Owner (full)" else "Device Admin (test)"
        Text("Mode: $mode", style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(20.dp))
        Text(
            "This device is managed by CyberSentinel MDM. Policy and commands " +
            "sync in the background.",
            style = MaterialTheme.typography.bodySmall
        )
    }
}
