package repository

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	"github.com/mdm/shared/models"
)

type RefreshRepo struct{ db *sqlx.DB }

func NewRefreshRepo(db *sqlx.DB) *RefreshRepo { return &RefreshRepo{db: db} }

func (r *RefreshRepo) Insert(ctx context.Context, t *models.RefreshToken) error {
	const q = `INSERT INTO refresh_tokens
		(id, tenant_id, subject_id, kind, token_hash, issued_at, expires_at, user_agent, ip_addr)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`
	if t.ID == uuid.Nil {
		t.ID = uuid.New()
	}
	_, err := r.db.ExecContext(ctx, q, t.ID, t.TenantID, t.SubjectID, t.Kind,
		t.TokenHash, t.IssuedAt, t.ExpiresAt, t.UserAgent, t.IPAddr)
	return err
}

func (r *RefreshRepo) FindActive(ctx context.Context, tokenHash string) (*models.RefreshToken, error) {
	const q = `SELECT id, tenant_id, subject_id, kind, token_hash, issued_at, expires_at,
	                  revoked_at, replaced_by, user_agent, ip_addr
	             FROM refresh_tokens
	            WHERE token_hash = $1`
	t := &models.RefreshToken{}
	if err := r.db.GetContext(ctx, t, q, tokenHash); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return t, nil
}

func (r *RefreshRepo) Rotate(ctx context.Context, oldID, newID uuid.UUID) error {
	const q = `UPDATE refresh_tokens SET revoked_at = $1, replaced_by = $2 WHERE id = $3`
	_, err := r.db.ExecContext(ctx, q, time.Now(), newID, oldID)
	return err
}

// RevokeChain marks the token and any descendants as revoked. Used when a
// revoked refresh token is presented (indicates token theft).
func (r *RefreshRepo) RevokeChain(ctx context.Context, id uuid.UUID) error {
	const q = `
	  WITH RECURSIVE chain(id) AS (
	    SELECT id FROM refresh_tokens WHERE id = $1
	    UNION ALL
	    SELECT rt.id FROM refresh_tokens rt JOIN chain c ON rt.replaced_by = c.id
	  )
	  UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now())
	   WHERE id IN (SELECT id FROM chain)`
	_, err := r.db.ExecContext(ctx, q, id)
	return err
}

func (r *RefreshRepo) Revoke(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.ExecContext(ctx, `UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, id)
	return err
}
