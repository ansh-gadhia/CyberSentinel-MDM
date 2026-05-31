package service

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"

	"github.com/mdm/device-service/internal/dto"
	"github.com/mdm/device-service/internal/repository"
	apperr "github.com/mdm/shared/errors"
	"github.com/mdm/shared/events"
	"github.com/mdm/shared/models"
	"github.com/mdm/shared/mq"
)

type DeviceService struct {
	devices *repository.DeviceRepo
	bus     *mq.Bus
}

func NewDeviceService(d *repository.DeviceRepo, bus *mq.Bus) *DeviceService {
	return &DeviceService{devices: d, bus: bus}
}

func (s *DeviceService) List(ctx context.Context, f repository.ListFilter) ([]models.Device, int, error) {
	return s.devices.List(ctx, f)
}

func (s *DeviceService) Get(ctx context.Context, tenantID, id uuid.UUID) (*models.Device, error) {
	d, err := s.devices.Get(ctx, tenantID, id)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, apperr.New(apperr.CodeNotFound, "device not found")
		}
		return nil, apperr.Wrap(apperr.CodeInternal, "get device", err)
	}
	return d, nil
}

func (s *DeviceService) Heartbeat(ctx context.Context, deviceID uuid.UUID, hb dto.HeartbeatRequest) error {
	// Detect a management-mode transition (none→admin→owner etc.) so we can
	// audit it. We snapshot the prior mode before the update; the first time a
	// mode is ever set (prior == nil) is treated as the baseline, not a change.
	var prevMode *string
	var tenantID uuid.UUID
	if hb.MgmtMode != nil {
		prevMode, tenantID, _ = s.devices.ModeAndTenant(ctx, deviceID)
	}
	if err := s.devices.Heartbeat(ctx, deviceID, repository.HeartbeatRich{
		AppliedVer:       hb.AppliedPolicyVer,
		Latitude:         hb.Latitude,
		Longitude:        hb.Longitude,
		AccuracyM:        hb.LocationAccuracyM,
		IPAddress:        hb.IPAddress,
		MACAddress:       hb.MACAddress,
		BatteryPct:       hb.Battery,
		Charging:         hb.Charging,
		VpnActive:        hb.VpnActive,
		StorageFreeBytes: hb.StorageFreeBytes,
		WifiSsid:         hb.WifiSsid,
		NetworkType:      hb.NetworkType,
		MgmtMode:         hb.MgmtMode,
	}); err != nil {
		return apperr.Wrap(apperr.CodeInternal, "heartbeat", err)
	}
	if s.bus != nil {
		evt, _ := json.Marshal(map[string]any{
			"device_id":    deviceID,
			"at":           time.Now(),
			"battery_pct":  hb.Battery,
			"network_type": hb.NetworkType,
			"applied_ver":  hb.AppliedPolicyVer,
		})
		_, _ = s.bus.JS.Publish("mdm.device.heartbeat", evt, nats.AckWait(2*time.Second))
	}
	// Emit an audit event only on an actual transition from a known prior mode
	// (suppresses the initial baseline set, e.g. null→none on first heartbeat).
	if hb.MgmtMode != nil && prevMode != nil && *prevMode != *hb.MgmtMode && tenantID != uuid.Nil {
		meta, _ := json.Marshal(map[string]any{"from": *prevMode, "to": *hb.MgmtMode})
		events.Emit(ctx, s.bus, events.AuditEnvelope{
			TenantID:   tenantID.String(),
			ActorID:    events.UUIDStrPtr(deviceID),
			ActorKind:  "device",
			Action:     "device.mode_changed",
			TargetKind: events.StrPtr("device"),
			TargetID:   events.UUIDStrPtr(deviceID),
			Metadata:   meta,
		})
	}
	return nil
}

func (s *DeviceService) UpdateInfo(ctx context.Context, id uuid.UUID, req dto.UpdateDeviceInfoRequest) error {
	if err := s.devices.UpdateInfo(ctx, id, req.Manufacturer, req.Model, req.OSVersion, req.SecurityPatchLevel); err != nil {
		return apperr.Wrap(apperr.CodeInternal, "update info", err)
	}
	return nil
}

// UpdateAlias sets the human-friendly device label and records who changed it
// in the audit log. actorID is the acting admin's user UUID (uuid.Nil if the
// caller couldn't be resolved, in which case the audit entry simply omits it).
func (s *DeviceService) UpdateAlias(ctx context.Context, tenantID, id, actorID uuid.UUID, alias *string) error {
	if err := s.devices.UpdateAlias(ctx, tenantID, id, alias); err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return apperr.New(apperr.CodeNotFound, "device not found")
		}
		return apperr.Wrap(apperr.CodeInternal, "update alias", err)
	}
	aliasVal := ""
	if alias != nil {
		aliasVal = *alias
	}
	meta, _ := json.Marshal(map[string]any{"alias": aliasVal})
	env := events.AuditEnvelope{
		TenantID:   tenantID.String(),
		ActorKind:  "user",
		Action:     "device.alias_updated",
		TargetKind: events.StrPtr("device"),
		TargetID:   events.UUIDStrPtr(id),
		Metadata:   meta,
	}
	if actorID != uuid.Nil {
		env.ActorID = events.UUIDStrPtr(actorID)
	}
	events.Emit(ctx, s.bus, env)
	return nil
}

// SetGroup assigns or clears (groupID == nil) a device's group, recording the
// actor. Returns NotFound if the device or (when assigning) the group doesn't
// exist in the tenant.
func (s *DeviceService) SetGroup(ctx context.Context, tenantID, id, actorID uuid.UUID, groupID *uuid.UUID) error {
	if err := s.devices.SetGroup(ctx, tenantID, id, groupID); err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return apperr.New(apperr.CodeNotFound, "device or group not found")
		}
		return apperr.Wrap(apperr.CodeInternal, "set group", err)
	}
	groupVal := ""
	if groupID != nil {
		groupVal = groupID.String()
	}
	meta, _ := json.Marshal(map[string]any{"group_id": groupVal})
	env := events.AuditEnvelope{
		TenantID:   tenantID.String(),
		ActorKind:  "user",
		Action:     "device.group_changed",
		TargetKind: events.StrPtr("device"),
		TargetID:   events.UUIDStrPtr(id),
		Metadata:   meta,
	}
	if actorID != uuid.Nil {
		env.ActorID = events.UUIDStrPtr(actorID)
	}
	events.Emit(ctx, s.bus, env)
	return nil
}

func (s *DeviceService) Retire(ctx context.Context, tenantID, id, actorID uuid.UUID) error {
	if err := s.devices.Retire(ctx, tenantID, id); err != nil {
		return apperr.Wrap(apperr.CodeInternal, "retire", err)
	}
	if s.bus != nil {
		evt, _ := json.Marshal(map[string]any{"device_id": id, "tenant_id": tenantID, "at": time.Now()})
		_, _ = s.bus.JS.Publish("mdm.device.retired", evt)
	}
	env := events.AuditEnvelope{
		TenantID:   tenantID.String(),
		ActorKind:  "user",
		Action:     "device.retired",
		TargetKind: events.StrPtr("device"),
		TargetID:   events.UUIDStrPtr(id),
	}
	if actorID != uuid.Nil {
		env.ActorID = events.UUIDStrPtr(actorID)
	}
	events.Emit(ctx, s.bus, env)
	return nil
}
