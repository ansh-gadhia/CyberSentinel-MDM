package repository

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	"github.com/mdm/shared/models"
)

var ErrNotFound = errors.New("not found")

type EnrollmentRepo struct{ db *sqlx.DB }

func NewEnrollmentRepo(db *sqlx.DB) *EnrollmentRepo { return &EnrollmentRepo{db: db} }

func (r *EnrollmentRepo) Create(ctx context.Context, tenantID, createdBy uuid.UUID, policyID *uuid.UUID, oneShot bool, maxUses int, ttl time.Duration) (*models.EnrollmentToken, error) {
	tok := make([]byte, 32)
	if _, err := rand.Read(tok); err != nil {
		return nil, err
	}
	plain := hex.EncodeToString(tok)
	now := time.Now()
	out := &models.EnrollmentToken{
		ID:        uuid.New(),
		TenantID:  tenantID,
		PolicyID:  policyID,
		Token:     plain,
		OneShot:   oneShot,
		MaxUses:   maxUses,
		ExpiresAt: now.Add(ttl),
		CreatedBy: createdBy,
		CreatedAt: now,
	}
	const q = `INSERT INTO enrollment_tokens
	  (id, tenant_id, policy_id, token, one_shot, used_count, max_uses, expires_at, created_by)
	  VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8)`
	if _, err := r.db.ExecContext(ctx, q,
		out.ID, out.TenantID, out.PolicyID, out.Token, out.OneShot, out.MaxUses, out.ExpiresAt, out.CreatedBy); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *EnrollmentRepo) GetByToken(ctx context.Context, token string) (*models.EnrollmentToken, error) {
	const q = `SELECT id, tenant_id, policy_id, token, one_shot, used_count, max_uses,
	                  expires_at, created_by, created_at
	             FROM enrollment_tokens WHERE token = $1`
	out := &models.EnrollmentToken{}
	if err := r.db.GetContext(ctx, out, q, token); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

func (r *EnrollmentRepo) GetByID(ctx context.Context, id uuid.UUID) (*models.EnrollmentToken, error) {
	const q = `SELECT id, tenant_id, policy_id, token, one_shot, used_count, max_uses,
	                  expires_at, created_by, created_at
	             FROM enrollment_tokens WHERE id = $1`
	out := &models.EnrollmentToken{}
	if err := r.db.GetContext(ctx, out, q, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

// ConsumeOne atomically increments used_count if the token is still valid.
// Returns the up-to-date token row or ErrNotFound if exhausted/expired.
func (r *EnrollmentRepo) ConsumeOne(ctx context.Context, id uuid.UUID) (*models.EnrollmentToken, error) {
	const q = `
	  UPDATE enrollment_tokens
	     SET used_count = used_count + 1
	   WHERE id = $1
	     AND expires_at > now()
	     AND used_count < max_uses
	  RETURNING id, tenant_id, policy_id, token, one_shot, used_count, max_uses, expires_at, created_by, created_at`
	out := &models.EnrollmentToken{}
	if err := r.db.GetContext(ctx, out, q, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}
