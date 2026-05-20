// Package types defines the canonical command kinds the Android agent
// understands. The agent must accept any new kind added here; conversely the
// server must never dispatch a kind missing from this list.
package types

type Kind string

const (
	KindLock                Kind = "LOCK"
	KindWipe                Kind = "WIPE"                  // factory reset
	KindReboot              Kind = "REBOOT"
	KindResetPassword       Kind = "RESET_PASSWORD"
	KindInstallApp          Kind = "INSTALL_APP"
	KindUninstallApp        Kind = "UNINSTALL_APP"
	KindHideApp             Kind = "HIDE_APP"
	KindShowApp             Kind = "SHOW_APP"
	KindFetchAppInventory   Kind = "FETCH_APP_INVENTORY"
	KindFetchRunningProcs   Kind = "FETCH_RUNNING_PROCESSES"
	KindFetchDeviceInfo     Kind = "FETCH_DEVICE_INFO"
	KindCollectLogs         Kind = "COLLECT_LOGS"
	KindApplyPolicy         Kind = "APPLY_POLICY"          // forces immediate policy pull
	KindClearPolicy         Kind = "CLEAR_POLICY"          // revert all policy-applied settings to default
	KindSetWifi             Kind = "SET_WIFI"
	KindSetVPN              Kind = "SET_VPN"
	KindSetGlobalProxy      Kind = "SET_GLOBAL_PROXY"
	KindInstallCertificate  Kind = "INSTALL_CERTIFICATE"
	KindRemoveCertificate   Kind = "REMOVE_CERTIFICATE"
	KindPushFile            Kind = "PUSH_FILE"
	KindPullFile            Kind = "PULL_FILE"
	KindRunIntegrityCheck   Kind = "RUN_INTEGRITY_CHECK"
	KindBlockUninstall      Kind = "BLOCK_UNINSTALL"
	KindAllowUninstall      Kind = "ALLOW_UNINSTALL"
	KindClearAppData        Kind = "CLEAR_APP_DATA"
	KindCapturePhoto        Kind = "CAPTURE_PHOTO"           // headless camera capture
	KindSetFlashlight       Kind = "SET_FLASHLIGHT"          // torch on/off
	KindPlaySound           Kind = "PLAY_SOUND"              // find-device buzzer
	KindGetLocation         Kind = "GET_LOCATION"            // last-known + a single fix
)

var Valid = map[Kind]struct{}{
	KindLock: {}, KindWipe: {}, KindReboot: {}, KindResetPassword: {},
	KindInstallApp: {}, KindUninstallApp: {}, KindHideApp: {}, KindShowApp: {},
	KindFetchAppInventory: {}, KindFetchRunningProcs: {}, KindFetchDeviceInfo: {},
	KindCollectLogs: {}, KindApplyPolicy: {}, KindClearPolicy: {}, KindSetWifi: {}, KindSetVPN: {},
	KindSetGlobalProxy: {}, KindInstallCertificate: {}, KindRemoveCertificate: {},
	KindPushFile: {}, KindPullFile: {}, KindRunIntegrityCheck: {},
	KindBlockUninstall: {}, KindAllowUninstall: {}, KindClearAppData: {},
	KindCapturePhoto: {}, KindSetFlashlight: {}, KindPlaySound: {}, KindGetLocation: {},
}
