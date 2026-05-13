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

var ErrNotFound = errors.New("not found")

type UserRepo struct{ db *sqlx.DB }

func NewUserRepo(db *sqlx.DB) *UserRepo { return &UserRepo{db: db} }

func (r *UserRepo) FindByEmail(ctx context.Context, email string) (*models.User, error) {
	const q = `SELECT id, tenant_id, email, password_hash, role, mfa_enabled, mfa_secret,
	                  last_login_at, created_at, updated_at, deleted_at
	             FROM users
	            WHERE email = $1 AND deleted_at IS NULL
	            LIMIT 1`
	u := &models.User{}
	if err := r.db.GetContext(ctx, u, q, email); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return u, nil
}

func (r *UserRepo) FindByID(ctx context.Context, id uuid.UUID) (*models.User, error) {
	const q = `SELECT id, tenant_id, email, password_hash, role, mfa_enabled, mfa_secret,
	                  last_login_at, created_at, updated_at, deleted_at
	             FROM users WHERE id = $1 AND deleted_at IS NULL`
	u := &models.User{}
	if err := r.db.GetContext(ctx, u, q, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return u, nil
}

func (r *UserRepo) TouchLogin(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.ExecContext(ctx, `UPDATE users SET last_login_at = $1 WHERE id = $2`, time.Now(), id)
	return err
}
