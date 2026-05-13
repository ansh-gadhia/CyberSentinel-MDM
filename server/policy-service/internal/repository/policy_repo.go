package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	"github.com/mdm/shared/models"
)

var ErrNotFound = errors.New("not found")

type PolicyRepo struct{ db *sqlx.DB }

func NewPolicyRepo(db *sqlx.DB) *PolicyRepo { return &PolicyRepo{db: db} }

// Create or bump version. We never mutate an existing (id,version) row — each
// edit produces version+1. Callers compute the diff against the previous
// version on the read path so the agent can pull a small delta.
func (r *PolicyRepo) CreateOrBumpVersion(ctx context.Context, tenantID, createdBy uuid.UUID, name string, spec json.RawMessage, baseID *uuid.UUID) (*models.Policy, error) {
	var id uuid.UUID
	var nextVer int
	if baseID == nil {
		id = uuid.New()
		nextVer = 1
	} else {
		id = *baseID
		if err := r.db.GetContext(ctx, &nextVer,
			`SELECT COALESCE(MAX(version),0)+1 FROM policies WHERE id = $1`, id); err != nil {
			return nil, err
		}
	}
	const q = `INSERT INTO policies (id, tenant_id, name, version, spec, created_by)
	           VALUES ($1,$2,$3,$4,$5,$6)
	           RETURNING id, tenant_id, name, version, spec, created_by, created_at, updated_at`
	out := &models.Policy{}
	if err := r.db.GetContext(ctx, out, q, id, tenantID, name, nextVer, spec, createdBy); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *PolicyRepo) GetLatest(ctx context.Context, tenantID, id uuid.UUID) (*models.Policy, error) {
	const q = `SELECT id, tenant_id, name, version, spec, created_by, created_at, updated_at
	             FROM policies WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
	            ORDER BY version DESC LIMIT 1`
	out := &models.Policy{}
	if err := r.db.GetContext(ctx, out, q, tenantID, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

func (r *PolicyRepo) GetVersion(ctx context.Context, id uuid.UUID, version int) (*models.Policy, error) {
	const q = `SELECT id, tenant_id, name, version, spec, created_by, created_at, updated_at
	             FROM policies WHERE id = $1 AND version = $2`
	out := &models.Policy{}
	if err := r.db.GetContext(ctx, out, q, id, version); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

func (r *PolicyRepo) ListLatest(ctx context.Context, tenantID uuid.UUID) ([]models.Policy, error) {
	const q = `
	  SELECT DISTINCT ON (id) id, tenant_id, name, version, spec, created_by, created_at, updated_at
	    FROM policies WHERE tenant_id = $1 AND deleted_at IS NULL
	   ORDER BY id, version DESC`
	out := []models.Policy{}
	if err := r.db.SelectContext(ctx, &out, q, tenantID); err != nil {
		return nil, err
	}
	return out, nil
}

// AssignedFor returns the policy currently bound to a device (via direct
// assignment, then group, then tenant default).
func (r *PolicyRepo) AssignedFor(ctx context.Context, tenantID, deviceID uuid.UUID) (*models.Policy, error) {
	const q = `
	  WITH target AS (
	    SELECT d.id AS device_id, d.group_id, d.assigned_policy_id
	      FROM devices d WHERE d.id = $2 AND d.tenant_id = $1
	  ),
	  picked AS (
	    SELECT policy_id FROM policy_assignments pa, target t
	      WHERE pa.tenant_id = $1
	        AND ((pa.target_kind = 'device' AND pa.target_id = t.device_id)
	          OR (pa.target_kind = 'group'  AND pa.target_id = t.group_id)
	          OR (pa.target_kind = 'tenant'))
	      ORDER BY CASE pa.target_kind
	                 WHEN 'device' THEN 1 WHEN 'group' THEN 2 WHEN 'tenant' THEN 3 END
	      LIMIT 1
	  )
	  SELECT id, tenant_id, name, version, spec, created_by, created_at, updated_at
	    FROM policies
	   WHERE id = (SELECT policy_id FROM picked)
	     AND deleted_at IS NULL
	   ORDER BY version DESC LIMIT 1`
	out := &models.Policy{}
	if err := r.db.GetContext(ctx, out, q, tenantID, deviceID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

func (r *PolicyRepo) Assign(ctx context.Context, tenantID, policyID uuid.UUID, targetKind string, targetID *uuid.UUID) error {
	const q = `INSERT INTO policy_assignments (tenant_id, policy_id, target_kind, target_id)
	           VALUES ($1,$2,$3,$4)`
	_, err := r.db.ExecContext(ctx, q, tenantID, policyID, targetKind, targetID)
	return err
}
