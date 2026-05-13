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
	"github.com/mdm/shared/models"
)

type CommandService struct{ repo *repository.CommandRepo }

func NewCommandService(r *repository.CommandRepo) *CommandService { return &CommandService{repo: r} }

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
	return cmd, nil
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
	return nil
}
