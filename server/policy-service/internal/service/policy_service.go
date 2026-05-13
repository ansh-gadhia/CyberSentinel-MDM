package service

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"

	"github.com/mdm/policy-service/internal/repository"
	apperr "github.com/mdm/shared/errors"
	"github.com/mdm/shared/models"
)

type PolicyService struct{ repo *repository.PolicyRepo }

func NewPolicyService(r *repository.PolicyRepo) *PolicyService { return &PolicyService{repo: r} }

type UpsertInput struct {
	BaseID    *uuid.UUID
	TenantID  uuid.UUID
	CreatedBy uuid.UUID
	Name      string
	Spec      json.RawMessage
}

func (s *PolicyService) Upsert(ctx context.Context, in UpsertInput) (*models.Policy, error) {
	if !json.Valid(in.Spec) {
		return nil, apperr.New(apperr.CodeInvalidInput, "spec must be valid JSON")
	}
	p, err := s.repo.CreateOrBumpVersion(ctx, in.TenantID, in.CreatedBy, in.Name, in.Spec, in.BaseID)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "save policy", err)
	}
	return p, nil
}

func (s *PolicyService) GetLatest(ctx context.Context, tenantID, id uuid.UUID) (*models.Policy, error) {
	p, err := s.repo.GetLatest(ctx, tenantID, id)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, apperr.New(apperr.CodeNotFound, "policy not found")
		}
		return nil, apperr.Wrap(apperr.CodeInternal, "get policy", err)
	}
	return p, nil
}

func (s *PolicyService) List(ctx context.Context, tenantID uuid.UUID) ([]models.Policy, error) {
	return s.repo.ListLatest(ctx, tenantID)
}

// Diff returns the JSON merge-patch (RFC 7396) between two policy versions.
// The Android agent applies only the diff so it can be small for large policies.
func (s *PolicyService) Diff(ctx context.Context, id uuid.UUID, from, to int) (json.RawMessage, error) {
	if from == to {
		return json.RawMessage("{}"), nil
	}
	fromP, err := s.repo.GetVersion(ctx, id, from)
	if err != nil && !errors.Is(err, repository.ErrNotFound) {
		return nil, apperr.Wrap(apperr.CodeInternal, "get policy from", err)
	}
	toP, err := s.repo.GetVersion(ctx, id, to)
	if err != nil {
		return nil, apperr.New(apperr.CodeNotFound, "target policy version not found")
	}
	var fromJSON, toJSON map[string]any
	if fromP != nil {
		_ = json.Unmarshal(fromP.Spec, &fromJSON)
	}
	_ = json.Unmarshal(toP.Spec, &toJSON)
	patch := mergePatch(fromJSON, toJSON)
	out, _ := json.Marshal(patch)
	return out, nil
}

// mergePatch produces a JSON merge patch that transforms `from` into `to`.
// keys removed from `to` become explicit nulls per RFC 7396.
func mergePatch(from, to map[string]any) map[string]any {
	patch := map[string]any{}
	for k, v := range to {
		fv, ok := from[k]
		if !ok || !deepEqual(fv, v) {
			if fm, fok := fv.(map[string]any); fok {
				if tm, tok := v.(map[string]any); tok {
					patch[k] = mergePatch(fm, tm)
					continue
				}
			}
			patch[k] = v
		}
	}
	for k := range from {
		if _, ok := to[k]; !ok {
			patch[k] = nil
		}
	}
	return patch
}

func deepEqual(a, b any) bool {
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	return string(ja) == string(jb)
}

func (s *PolicyService) AssignedFor(ctx context.Context, tenantID, deviceID uuid.UUID) (*models.Policy, error) {
	p, err := s.repo.AssignedFor(ctx, tenantID, deviceID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, apperr.New(apperr.CodeNotFound, "no policy assigned")
		}
		return nil, apperr.Wrap(apperr.CodeInternal, "assigned policy", err)
	}
	return p, nil
}

func (s *PolicyService) Assign(ctx context.Context, tenantID, policyID uuid.UUID, kind string, targetID *uuid.UUID) error {
	if kind != "device" && kind != "group" && kind != "tenant" {
		return apperr.New(apperr.CodeInvalidInput, "invalid target_kind")
	}
	if err := s.repo.Assign(ctx, tenantID, policyID, kind, targetID); err != nil {
		return apperr.Wrap(apperr.CodeInternal, "assign", err)
	}
	return nil
}
