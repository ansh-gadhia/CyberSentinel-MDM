package service

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/mdm/command-service/internal/repository"
	"github.com/mdm/command-service/internal/types"
	apperr "github.com/mdm/shared/errors"
	"github.com/mdm/shared/events"
	"github.com/mdm/shared/models"
	"github.com/mdm/shared/mq"
)

type CommandService struct {
	repo *repository.CommandRepo
	bus  *mq.Bus
}

func NewCommandService(r *repository.CommandRepo, bus *mq.Bus) *CommandService {
	return &CommandService{repo: r, bus: bus}
}

type CreateInput struct {
	TenantID    uuid.UUID
	CreatedBy   uuid.UUID
	DeviceID    uuid.UUID
	Kind        string
	Payload     json.RawMessage
	MaxAttempts int
	Timeout     time.Duration
}

func (s *CommandService) Create(ctx context.Context, in CreateInput) (*models.Command, error) {
	if _, ok := types.Valid[types.Kind(in.Kind)]; !ok {
		return nil, apperr.New(apperr.CodeInvalidInput, "unknown command kind")
	}
	if in.MaxAttempts <= 0 {
		in.MaxAttempts = 3
	}
	if in.Timeout <= 0 {
		in.Timeout = 10 * time.Minute
	}
	if !json.Valid(in.Payload) {
		in.Payload = json.RawMessage(`{}`)
	}
	cmd := &models.Command{
		TenantID:    in.TenantID,
		DeviceID:    in.DeviceID,
		Kind:        in.Kind,
		Payload:     in.Payload,
		State:       models.CommandStatePending,
		MaxAttempts: in.MaxAttempts,
		TimeoutAt:   time.Now().Add(in.Timeout),
		CreatedBy:   in.CreatedBy,
	}
	if err := s.repo.Insert(ctx, cmd); err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "insert command", err)
	}
	meta, _ := json.Marshal(map[string]any{"kind": cmd.Kind, "device_id": cmd.DeviceID.String()})
	events.Emit(ctx, s.bus, events.AuditEnvelope{
		TenantID:   cmd.TenantID.String(),
		ActorID:    events.UUIDStrPtr(cmd.CreatedBy),
		ActorKind:  "user",
		Action:     "command.created." + cmd.Kind,
		TargetKind: events.StrPtr("device"),
		TargetID:   events.UUIDStrPtr(cmd.DeviceID),
		Metadata:   meta,
	})
	return cmd, nil
}

type BroadcastInput struct {
	TenantID  uuid.UUID
	CreatedBy uuid.UUID
	GroupID   uuid.UUID
	Kind      string
	Payload   json.RawMessage
}

// Broadcast fans a command out to every live device in a group, creating one
// command per device (reusing Create, so each is validated + audited).
func (s *CommandService) Broadcast(ctx context.Context, in BroadcastInput) (int, error) {
	if _, ok := types.Valid[types.Kind(in.Kind)]; !ok {
		return 0, apperr.New(apperr.CodeInvalidInput, "unknown command kind")
	}
	ids, err := s.repo.DeviceIDsInGroup(ctx, in.TenantID, in.GroupID)
	if err != nil {
		return 0, apperr.Wrap(apperr.CodeInternal, "group devices", err)
	}
	n := 0
	for _, did := range ids {
		if _, err := s.Create(ctx, CreateInput{
			TenantID:  in.TenantID,
			CreatedBy: in.CreatedBy,
			DeviceID:  did,
			Kind:      in.Kind,
			Payload:   in.Payload,
		}); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

func (s *CommandService) Get(ctx context.Context, tenantID, id uuid.UUID) (*models.Command, error) {
	c, err := s.repo.Get(ctx, tenantID, id)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, apperr.New(apperr.CodeNotFound, "command not found")
		}
		return nil, apperr.Wrap(apperr.CodeInternal, "get command", err)
	}
	return c, nil
}

func (s *CommandService) ListForDevice(ctx context.Context, tenantID, deviceID uuid.UUID, limit int) ([]models.Command, error) {
	return s.repo.ListForDevice(ctx, tenantID, deviceID, limit)
}

// Poll is used by the agent as a fallback path if MQTT is unavailable. It
// claims pending commands for this device and returns them.
func (s *CommandService) Poll(ctx context.Context, deviceID uuid.UUID, limit int) ([]models.Command, error) {
	if limit <= 0 || limit > 50 {
		limit = 16
	}
	return s.repo.ClaimPending(ctx, deviceID, limit)
}

func (s *CommandService) Ack(ctx context.Context, id uuid.UUID) error {
	if err := s.repo.Acknowledge(ctx, id); err != nil {
		return apperr.Wrap(apperr.CodeInternal, "ack", err)
	}
	return nil
}

type ResultInput struct {
	Success bool            `json:"success"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   string          `json:"error,omitempty"`
}

func (s *CommandService) Result(ctx context.Context, id uuid.UUID, in ResultInput) error {
	if err := s.repo.Complete(ctx, id, in.Success, in.Result, in.Error); err != nil {
		return apperr.Wrap(apperr.CodeInternal, "complete", err)
	}
	// Best-effort audit emit. We re-read the command so the audit entry carries
	// tenant + device context even though the device-side callback only has id.
	if cmd, err := s.repo.GetByID(ctx, id); err == nil && cmd != nil {
		action := "command.succeeded." + cmd.Kind
		if !in.Success {
			action = "command.failed." + cmd.Kind
		}
		meta, _ := json.Marshal(map[string]any{
			"kind":     cmd.Kind,
			"error":    in.Error,
			"attempts": cmd.Attempts,
		})
		events.Emit(ctx, s.bus, events.AuditEnvelope{
			TenantID:   cmd.TenantID.String(),
			ActorKind:  "device",
			ActorID:    events.UUIDStrPtr(cmd.DeviceID),
			Action:     action,
			TargetKind: events.StrPtr("device"),
			TargetID:   events.UUIDStrPtr(cmd.DeviceID),
			Metadata:   meta,
		})
	}
	return nil
}
