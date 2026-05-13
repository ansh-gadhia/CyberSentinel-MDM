package com.mdm.agent.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun EnrollmentScreen(vm: MainViewModel) {
    var server by remember { mutableStateOf("https://mdm.example.com") }
    var token by remember { mutableStateOf("") }
    val busy by vm.busy.collectAsState()
    val error by vm.error.collectAsState()

    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center
    ) {
        Text("CyberSentinel MDM", style = MaterialTheme.typography.headlineSmall)
        Text("Virtual Galaxy Infotech Ltd", style = MaterialTheme.typography.labelSmall)
        Spacer(Modifier.height(20.dp))
        Text("Device enrollment", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(value = server, onValueChange = { server = it }, label = { Text("Server URL") })
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(value = token, onValueChange = { token = it }, label = { Text("Enrollment token") })
        Spacer(Modifier.height(16.dp))
        Button(onClick = { vm.enroll(server, token) }, enabled = !busy && token.isNotBlank()) {
            if (busy) CircularProgressIndicator(strokeWidth = 2.dp)
            else Text("Enroll")
        }
        error?.let {
            Spacer(Modifier.height(12.dp))
            Text(it, color = MaterialTheme.colorScheme.error)
        }
    }
}
