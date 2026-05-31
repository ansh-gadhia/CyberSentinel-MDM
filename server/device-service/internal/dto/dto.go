package dto

import "time"

// ---------- enrollment ----------

type CreateEnrollmentTokenRequest struct {
	PolicyID  *string `json:"policy_id,omitempty"`
	OneShot   bool    `json:"one_shot"`
	MaxUses   int     `json:"max_uses"`
	ExpiresIn string  `json:"expires_in"` // duration, e.g. "24h"
}

type CreateEnrollmentTokenResponse struct {
	ID         string    `json:"id"`
	Token      string    `json:"token"`
	ExpiresAt  time.Time `json:"expires_at"`
	QRURL      string    `json:"qr_url"`       // GET this for the JSON QR payload
	ProvisionURL string  `json:"provision_url"` // direct deep link
}

type EnrollRequest struct {
	Token        string `json:"token"`
	SerialNumber string `json:"serial_number,omitempty"`
	IMEI         string `json:"imei,omitempty"`
	AndroidID    string `json:"android_id,omitempty"`
	Manufacturer string `json:"manufacturer,omitempty"`
	Model        string `json:"model,omitempty"`
	OSVersion    string `json:"os_version,omitempty"`
	SecurityPatch string `json:"security_patch_level,omitempty"`
}

type EnrollResponse struct {
	DeviceID     string `json:"device_id"`
	TenantID     string `json:"tenant_id"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	MQTTTopic    string `json:"mqtt_topic"`
	MQTTUser     string `json:"mqtt_user"`
	PolicyURL    string `json:"policy_url"`
	HeartbeatSec int    `json:"heartbeat_sec"`
}

// QRPayload mirrors Android's PROVISIONING_DEVICE_ADMIN_EXTRAS_BUNDLE shape.
type QRPayload struct {
	AndroidEnterpriseSetup    bool              `json:"android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME,omitempty"`
	DPCPackage                string            `json:"android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_NAME"`
	DPCComponent              string            `json:"android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME_STR,omitempty"`
	DPCSignatureChecksum      string            `json:"android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM"`
	DPCDownloadLocation       string            `json:"android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION"`
	SkipEncryption            bool              `json:"android.app.extra.PROVISIONING_SKIP_ENCRYPTION"`
	LeaveAllSystemAppsEnabled bool              `json:"android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED"`
	AdminExtras               map[string]string `json:"android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE"`
}

// ---------- devices ----------

type HeartbeatRequest struct {
	Battery            *int     `json:"battery_pct,omitempty"`
	Charging           *bool    `json:"charging,omitempty"`
	NetworkType        *string  `json:"network_type,omitempty"`
	VpnActive          *bool    `json:"vpn_active,omitempty"`
	AppliedPolicyVer   *int     `json:"applied_policy_version,omitempty"`
	Latitude           *float64 `json:"latitude,omitempty"`
	Longitude          *float64 `json:"longitude,omitempty"`
	LocationAccuracyM  *float32 `json:"location_accuracy_m,omitempty"`
	IPAddress          *string  `json:"ip_address,omitempty"`
	MACAddress         *string  `json:"mac_address,omitempty"`
	StorageFreeBytes   *int64   `json:"storage_free_bytes,omitempty"`
	WifiSsid           *string  `json:"wifi_ssid,omitempty"`
	MgmtMode           *string  `json:"mgmt_mode,omitempty"` // owner | admin | none
}

// UpdateDeviceRequest is the admin-side PATCH /devices/:id body. Only the
// fields present are touched; today that's the alias. `alias` is a pointer so
// the handler can tell "not supplied" (nil → no change) apart from "clear it"
// (explicit empty string).
type UpdateDeviceRequest struct {
	Alias *string `json:"alias,omitempty"`
	// GroupID: a UUID string to assign the device to a group, or an explicit
	// empty string "" to clear group membership. Omitted (nil) = no change.
	GroupID *string `json:"group_id,omitempty"`
}

// ---------- device groups ----------

type CreateGroupRequest struct {
	Name        string  `json:"name"`
	Description *string `json:"description,omitempty"`
}

type UpdateGroupRequest struct {
	Name        *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
}

type UpdateDeviceInfoRequest struct {
	Manufacturer        *string `json:"manufacturer,omitempty"`
	Model               *string `json:"model,omitempty"`
	OSVersion           *string `json:"os_version,omitempty"`
	SecurityPatchLevel  *string `json:"security_patch_level,omitempty"`
}
