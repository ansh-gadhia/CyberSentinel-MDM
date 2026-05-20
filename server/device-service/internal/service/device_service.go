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
	return nil
}

func (s *DeviceService) UpdateInfo(ctx context.Context, id uuid.UUID, req dto.UpdateDeviceInfoRequest) error {
	if err := s.devices.UpdateInfo(ctx, id, req.Manufacturer, req.Model, req.OSVersion, req.SecurityPatchLevel); err != nil {
		return apperr.Wrap(apperr.CodeInternal, "update info", err)
	}
	return nil
}

func (s *DeviceService) Retire(ctx context.Context, tenantID, id uuid.UUID) error {
	if err := s.devices.Retire(ctx, tenantID, id); err != nil {
		return apperr.Wrap(apperr.CodeInternal, "retire", err)
	}
	if s.bus != nil {
		evt, _ := json.Marshal(map[string]any{"device_id": id, "tenant_id": tenantID, "at": time.Now()})
		_, _ = s.bus.JS.Publish("mdm.device.retired", evt)
	}
	events.Emit(ctx, s.bus, events.AuditEnvelope{
		TenantID:   tenantID.String(),
		ActorKind:  "user",
		Action:     "device.retired",
		TargetKind: events.StrPtr("device"),
		TargetID:   events.UUIDStrPtr(id),
	})
	return nil
}
