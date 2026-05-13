// Package service holds the enrollment + device use cases.
//
// Enrollment flow:
//   1. Admin POST /api/v1/enroll/tokens — returns an enrollment token id+token.
//   2. Admin renders a QR (the JSON payload at /api/v1/enroll/qr/:tokenID).
//   3. Factory-reset Android device scans QR. Setup Wizard downloads the DPC
//      from PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION and sets it as
//      Device Owner; the DPC reads PROVISIONING_ADMIN_EXTRAS_BUNDLE which
//      contains the enrollment token + server URL.
//   4. DPC calls POST /api/v1/enroll → server creates the Device row and
//      returns access + refresh tokens, MQTT credentials, and bootstrapping
//      info.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/nats-io/nats.go"

	"github.com/mdm/device-service/internal/dto"
	"github.com/mdm/device-service/internal/repository"
	"github.com/mdm/shared/auth"
	apperr "github.com/mdm/shared/errors"
	"github.com/mdm/shared/models"
	"github.com/mdm/shared/mq"
)

const (
	// DPCSignatureChecksum is the urlsafe-base64 SHA-256 of the agent APK's
	// signing certificate. Replace with your real signing cert's checksum.
	// Computed via: `keytool -list -printcert -file CERT.RSA` then SHA-256 of
	// the DER, base64 URL-encoded (Android requires the URL-safe variant).
	DPCSignatureChecksum = "REPLACE_WITH_AGENT_APK_SIGNING_CERT_SHA256_URLSAFE_B64"

	DPCPackageName = "com.mdm.agent"
	DPCComponent   = "com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver"
)

type EnrollmentService struct {
	devices       *repository.DeviceRepo
	tokens        *repository.EnrollmentRepo
	db            *sqlx.DB
	issuer        *auth.Issuer
	bus           *mq.Bus
	publicBaseURL string
	refreshTTL    time.Duration
}

func NewEnrollmentService(d *repository.DeviceRepo, t *repository.EnrollmentRepo, db *sqlx.DB, iss *auth.Issuer, bus *mq.Bus, baseURL string, refreshTTL time.Duration) *EnrollmentService {
	return &EnrollmentService{
		devices: d, tokens: t, db: db,
		issuer: iss, bus: bus,
		publicBaseURL: baseURL,
		refreshTTL:    refreshTTL,
	}
}

type CreateTokenInput struct {
	TenantID  uuid.UUID
	CreatedBy uuid.UUID
	PolicyID  *uuid.UUID
	OneShot   bool
	MaxUses   int
	TTL       time.Duration
}

func (s *EnrollmentService) CreateToken(ctx context.Context, in CreateTokenInput) (*dto.CreateEnrollmentTokenResponse, error) {
	if in.MaxUses <= 0 {
		in.MaxUses = 1
	}
	if in.TTL <= 0 {
		in.TTL = 24 * time.Hour
	}
	tok, err := s.tokens.Create(ctx, in.TenantID, in.CreatedBy, in.PolicyID, in.OneShot, in.MaxUses, in.TTL)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "create enrollment token", err)
	}
	return &dto.CreateEnrollmentTokenResponse{
		ID:           tok.ID.String(),
		Token:        tok.Token,
		ExpiresAt:    tok.ExpiresAt,
		QRURL:        fmt.Sprintf("%s/api/v1/enroll/qr/%s", s.publicBaseURL, tok.ID),
		ProvisionURL: fmt.Sprintf("%s/enroll?token=%s", s.publicBaseURL, tok.Token),
	}, nil
}

// BuildQRPayload returns the JSON that should be encoded into the QR. The
// Android Setup Wizard reads this as the `provisioning` extras bundle.
func (s *EnrollmentService) BuildQRPayload(ctx context.Context, tokenID uuid.UUID) (dto.QRPayload, error) {
	tok, err := s.tokens.GetByID(ctx, tokenID)
	if err != nil {
		return dto.QRPayload{}, apperr.New(apperr.CodeNotFound, "enrollment token not found")
	}
	if time.Now().After(tok.ExpiresAt) {
		return dto.QRPayload{}, apperr.New(apperr.CodeConflict, "enrollment token expired")
	}
	extras := map[string]string{
		"server_url":       s.publicBaseURL,
		"enrollment_token": tok.Token,
		"tenant_id":        tok.TenantID.String(),
	}
	return dto.QRPayload{
		DPCPackage:                DPCPackageName,
		DPCComponent:              DPCComponent,
		DPCSignatureChecksum:      DPCSignatureChecksum,
		DPCDownloadLocation:       fmt.Sprintf("%s/api/v1/files/agent/latest.apk", s.publicBaseURL),
		SkipEncryption:            false,
		LeaveAllSystemAppsEnabled: true,
		AdminExtras:               extras,
	}, nil
}

func (s *EnrollmentService) Enroll(ctx context.Context, in dto.EnrollRequest) (*dto.EnrollResponse, error) {
	if in.Token == "" {
		return nil, apperr.New(apperr.CodeInvalidInput, "token required")
	}
	tok, err := s.tokens.GetByToken(ctx, in.Token)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, apperr.New(apperr.CodeUnauthorized, "invalid enrollment token")
		}
		return nil, apperr.Wrap(apperr.CodeInternal, "find token", err)
	}
	consumed, err := s.tokens.ConsumeOne(ctx, tok.ID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, apperr.New(apperr.CodeConflict, "enrollment token exhausted or expired")
		}
		return nil, apperr.Wrap(apperr.CodeInternal, "consume token", err)
	}

	dev := &models.Device{
		TenantID:           consumed.TenantID,
		EnrollmentTokenID:  &consumed.ID,
		SerialNumber:       optStr(in.SerialNumber),
		IMEI:               optStr(in.IMEI),
		AndroidID:          optStr(in.AndroidID),
		Manufacturer:       optStr(in.Manufacturer),
		Model:              optStr(in.Model),
		OSVersion:          optStr(in.OSVersion),
		SecurityPatchLevel: optStr(in.SecurityPatch),
		State:              models.DeviceStateEnrolled,
		AssignedPolicyID:   consumed.PolicyID,
		Tags:               json.RawMessage(`{}`),
		Metadata:           json.RawMessage(`{}`),
	}
	if err := s.devices.Create(ctx, dev); err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "create device", err)
	}

	access, err := s.issuer.IssueDevice(dev.ID, dev.TenantID)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "issue device token", err)
	}
	// Device refresh token: persist with kind='device' so the agent can
	// rotate its access token via /auth/refresh without re-enrolling.
	refreshPlain, refreshHash, err := auth.NewRefreshToken()
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "refresh token", err)
	}
	ttl := s.refreshTTL
	if ttl <= 0 {
		ttl = 168 * time.Hour
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO refresh_tokens
	  (id, tenant_id, subject_id, kind, token_hash, issued_at, expires_at)
	  VALUES ($1,$2,$3,'device',$4,$5,$6)`,
		uuid.New(), dev.TenantID, dev.ID, refreshHash, time.Now(), time.Now().Add(ttl),
	); err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "persist refresh token", err)
	}

	// Publish enrollment event for downstream consumers (audit, policy assign).
	if s.bus != nil {
		evt, _ := json.Marshal(map[string]any{
			"device_id": dev.ID,
			"tenant_id": dev.TenantID,
			"policy_id": consumed.PolicyID,
			"at":        time.Now(),
		})
		_, _ = s.bus.JS.Publish("mdm.device.enrolled", evt, nats.AckWait(2*time.Second))
	}

	return &dto.EnrollResponse{
		DeviceID:     dev.ID.String(),
		TenantID:     dev.TenantID.String(),
		AccessToken:  access,
		RefreshToken: refreshPlain,
		MQTTTopic:    fmt.Sprintf("mdm/%s/devices/%s/cmd", dev.TenantID, dev.ID),
		MQTTUser:     "device-" + dev.ID.String(),
		PolicyURL:    fmt.Sprintf("%s/api/v1/policies/assigned", s.publicBaseURL),
		HeartbeatSec: 60,
	}, nil
}

func optStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
