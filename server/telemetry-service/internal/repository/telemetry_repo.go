package repository

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	"github.com/mdm/shared/models"
)

type TelemetryRepo struct{ db *sqlx.DB }

func NewTelemetryRepo(db *sqlx.DB) *TelemetryRepo { return &TelemetryRepo{db: db} }

func (r *TelemetryRepo) Ingest(ctx context.Context, evs []models.TelemetryEvent) error {
	if len(evs) == 0 {
		return nil
	}
	tx, err := r.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmtInsert, err := tx.PreparexContext(ctx, `
	  INSERT INTO telemetry_events (id, tenant_id, device_id, kind, payload, captured_at, received_at)
	  VALUES ($1,$2,$3,$4,$5,$6,$7)`)
	if err != nil {
		return err
	}
	defer stmtInsert.Close()
	stmtLatest, err := tx.PreparexContext(ctx, `
	  INSERT INTO device_telemetry_latest (device_id, kind, tenant_id, payload, captured_at)
	  VALUES ($1,$2,$3,$4,$5)
	  ON CONFLICT (device_id, kind) DO UPDATE
	     SET tenant_id   = EXCLUDED.tenant_id,
	         payload     = EXCLUDED.payload,
	         captured_at = EXCLUDED.captured_at,
	         updated_at  = now()
	   WHERE EXCLUDED.captured_at >= device_telemetry_latest.captured_at`)
	if err != nil {
		return err
	}
	defer stmtLatest.Close()

	now := time.Now()
	for _, e := range evs {
		if e.ID == uuid.Nil {
			e.ID = uuid.New()
		}
		if _, err := stmtInsert.ExecContext(ctx, e.ID, e.TenantID, e.DeviceID, e.Kind, e.Payload, e.CapturedAt, now); err != nil {
			return err
		}
		if _, err := stmtLatest.ExecContext(ctx, e.DeviceID, e.Kind, e.TenantID, e.Payload, e.CapturedAt); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (r *TelemetryRepo) Latest(ctx context.Context, tenantID, deviceID uuid.UUID) (map[string]json.RawMessage, error) {
	rows, err := r.db.QueryxContext(ctx, `
		SELECT kind, payload FROM device_telemetry_latest
		 WHERE tenant_id = $1 AND device_id = $2`, tenantID, deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]json.RawMessage{}
	for rows.Next() {
		var kind string
		var payload json.RawMessage
		if err := rows.Scan(&kind, &payload); err != nil {
			return nil, err
		}
		out[kind] = payload
	}
	return out, nil
}
