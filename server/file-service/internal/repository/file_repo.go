package repository

import (
	"context"
	"database/sql"
	"errors"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	"github.com/mdm/shared/models"
)

var ErrNotFound = errors.New("not found")

type FileRepo struct{ db *sqlx.DB }

func NewFileRepo(db *sqlx.DB) *FileRepo { return &FileRepo{db: db} }

func (r *FileRepo) Insert(ctx context.Context, f *models.FileObject) error {
	if f.ID == uuid.Nil {
		f.ID = uuid.New()
	}
	const q = `INSERT INTO file_objects
	  (id, tenant_id, name, kind, storage_key, sha256, size_bytes, content_type, uploaded_by)
	  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`
	_, err := r.db.ExecContext(ctx, q,
		f.ID, f.TenantID, f.Name, f.Kind, f.StorageKey, f.SHA256, f.SizeBytes, f.ContentType, f.UploadedBy)
	return err
}

func (r *FileRepo) Get(ctx context.Context, tenantID, id uuid.UUID) (*models.FileObject, error) {
	const q = `SELECT * FROM file_objects WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`
	out := &models.FileObject{}
	if err := r.db.GetContext(ctx, out, q, tenantID, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

func (r *FileRepo) List(ctx context.Context, tenantID uuid.UUID, kind string) ([]models.FileObject, error) {
	args := []any{tenantID}
	q := `SELECT * FROM file_objects WHERE tenant_id = $1 AND deleted_at IS NULL`
	if kind != "" {
		q += " AND kind = $2"
		args = append(args, kind)
	}
	q += " ORDER BY created_at DESC"
	out := []models.FileObject{}
	err := r.db.SelectContext(ctx, &out, q, args...)
	return out, err
}
