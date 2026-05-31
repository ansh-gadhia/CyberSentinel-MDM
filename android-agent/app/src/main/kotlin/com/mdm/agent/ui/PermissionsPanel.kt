package com.mdm.agent.ui

import android.Manifest
import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Process
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp

/**
 * Lists the runtime + special-access permissions the agent needs and lets the
 * user grant the missing ones. This fills the gap in Device Admin / "none"
 * modes, where the agent can't auto-grant anything via DPM — without this
 * panel, remote camera/mic/location commands silently failed because the OS
 * never granted the permission. In Device Owner mode the runtime permissions
 * are already auto-granted, so only "activity monitoring" (usage access, which
 * even Device Owner can't grant programmatically) shows as pending.
 */

private data class PermItem(val label: String, val manifest: String)

private fun neededRuntimePerms(): List<PermItem> = buildList {
    add(PermItem("Camera (remote photo capture)", Manifest.permission.CAMERA))
    add(PermItem("Microphone (audio capture)", Manifest.permission.RECORD_AUDIO))
    add(PermItem("Location", Manifest.permission.ACCESS_FINE_LOCATION))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        add(PermItem("Notifications", Manifest.permission.POST_NOTIFICATIONS))
    }
    add(PermItem("Phone state (serial / IMEI)", Manifest.permission.READ_PHONE_STATE))
}

private fun hasRuntime(ctx: Context, perm: String): Boolean =
    ctx.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED

private fun hasUsageAccess(ctx: Context): Boolean {
    val ops = ctx.getSystemService(AppOpsManager::class.java) ?: return false
    val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName)
    } else {
        @Suppress("DEPRECATION")
        ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName)
    }
    return mode == AppOpsManager.MODE_ALLOWED
}

@Composable
fun PermissionsPanel(deviceOwner: Boolean) {
    val ctx = LocalContext.current
    // `tick` is bumped to force a re-evaluation of grant state after the user
    // returns from the permission dialog / Settings.
    var tick by remember { mutableStateOf(0) }

    val runtime = remember(tick) { neededRuntimePerms().map { it to hasRuntime(ctx, it.manifest) } }
    val usageGranted = remember(tick) { hasUsageAccess(ctx) }
    val missing = runtime.filter { !it.second }.map { it.first.manifest }

    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        tick++
        // Restart the service so it re-declares its foreground-service types
        // with the newly granted camera/mic/location permission (Android 14
        // ties those FGS types to holding the permission at start time).
        runCatching { com.mdm.command.CommandService.start(ctx) }
    }

    Card(Modifier.fillMaxWidth().padding(top = 16.dp)) {
        Column(Modifier.padding(16.dp)) {
            Text("Permissions", style = MaterialTheme.typography.titleMedium)
            Text(
                if (deviceOwner)
                    "Device Owner auto-grants app permissions. Only activity monitoring (usage access) must be enabled by hand — Android won't let any app grant that automatically."
                else
                    "This device isn't a Device Owner, so permissions aren't auto-granted. Grant the items below so remote camera, audio and location work.",
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(top = 4.dp)
            )
            Spacer(Modifier.height(12.dp))

            runtime.forEach { (item, granted) ->
                PermRow(item.label, granted)
            }
            PermRow("Activity monitoring (usage access)", usageGranted)

            Spacer(Modifier.height(12.dp))
            if (missing.isNotEmpty()) {
                Button(
                    onClick = { launcher.launch(missing.toTypedArray()) },
                    modifier = Modifier.fillMaxWidth()
                ) { Text("Grant app permissions") }
                Spacer(Modifier.height(8.dp))
            }
            if (!usageGranted) {
                OutlinedButton(
                    onClick = {
                        runCatching {
                            ctx.startActivity(
                                Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).apply {
                                    data = Uri.fromParts("package", ctx.packageName, null)
                                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                }
                            )
                        }
                        tick++
                    },
                    modifier = Modifier.fillMaxWidth()
                ) { Text("Enable activity monitoring") }
                Spacer(Modifier.height(8.dp))
            }
            if (missing.isEmpty() && usageGranted) {
                Text("All permissions granted ✓", style = MaterialTheme.typography.bodyMedium)
            }
            TextButton(onClick = { tick++ }, modifier = Modifier.fillMaxWidth()) { Text("Re-check") }
        }
    }
}

@Composable
private fun PermRow(label: String, granted: Boolean) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Text(if (granted) "Granted" else "Needed", style = MaterialTheme.typography.bodyMedium)
    }
}
