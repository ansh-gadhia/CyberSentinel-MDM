// Package service holds the auth use cases: login, refresh, logout, identity.
// The handler layer is a thin adapter to HTTP; business logic lives here.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"

	"github.com/mdm/auth-service/internal/repository"
	"github.com/mdm/shared/auth"
	"github.com/mdm/shared/authz"
	apperr "github.com/mdm/shared/errors"
	"github.com/mdm/shared/events"
	"github.com/mdm/shared/models"
	"github.com/mdm/shared/mq"
)

type AuthService struct {
	users      *repository.UserRepo
	refresh    *repository.RefreshRepo
	issuer     *auth.Issuer
	refreshTTL time.Duration
	bus        *mq.Bus
}

func NewAuthService(u *repository.UserRepo, r *repository.RefreshRepo, iss *auth.Issuer, refreshTTL time.Duration, bus *mq.Bus) *AuthService {
	return &AuthService{users: u, refresh: r, issuer: iss, refreshTTL: refreshTTL, bus: bus}
}

type LoginInput struct {
	Email     string
	Password  string
	UserAgent string
	IP        string
}

type TokenPair struct {
	Access  string
	Refresh string
	User    *models.User
}

func (s *AuthService) Login(ctx context.Context, in LoginInput) (*TokenPair, error) {
	u, err := s.users.FindByEmail(ctx, in.Email)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, apperr.New(apperr.CodeUnauthorized, "invalid credentials")
		}
		return nil, apperr.Wrap(apperr.CodeInternal, "user lookup", err)
	}
	if !auth.VerifyPassword(u.PasswordHash, in.Password) {
		return nil, apperr.New(apperr.CodeUnauthorized, "invalid credentials")
	}
	// MFA: not enforced here — but the column is wired through so a future
	// `mfa_required` step can plug in here once an enrolment endpoint exists.

	access, err := s.issuer.IssueUser(u.ID, u.TenantID, string(u.Role))
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "issue access", err)
	}
	plain, hash, err := auth.NewRefreshToken()
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "issue refresh", err)
	}

	now := time.Now()
	if err := s.refresh.Insert(ctx, &models.RefreshToken{
		ID:        uuid.New(),
		TenantID:  u.TenantID,
		SubjectID: u.ID,
		Kind:      "user",
		TokenHash: hash,
		IssuedAt:  now,
		ExpiresAt: now.Add(s.refreshTTL),
		UserAgent: ptr(in.UserAgent),
		IPAddr:    ptr(in.IP),
	}); err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "persist refresh", err)
	}
	if err := s.users.TouchLogin(ctx, u.ID); err != nil {
		log.Warn().Err(err).Msg("touch login")
	}

	return &TokenPair{Access: access, Refresh: plain, User: u}, nil
}

// Refresh implements rotation. If a presented token was already revoked, the
// whole chain is invalidated (theft heuristic).
func (s *AuthService) Refresh(ctx context.Context, plain, userAgent, ip string) (*TokenPair, error) {
	hash := auth.HashRefresh(plain)
	tok, err := s.refresh.FindActive(ctx, hash)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, apperr.New(apperr.CodeUnauthorized, "invalid refresh token")
		}
		return nil, apperr.Wrap(apperr.CodeInternal, "find refresh", err)
	}
	if tok.RevokedAt != nil {
		// Possible reuse of a stolen token. Revoke the entire chain.
		_ = s.refresh.RevokeChain(ctx, tok.ID)
		log.Warn().Str("token_id", tok.ID.String()).Msg("revoked-token replay detected")
		return nil, apperr.New(apperr.CodeUnauthorized, "refresh token revoked")
	}
	if time.Now().After(tok.ExpiresAt) {
		return nil, apperr.New(apperr.CodeUnauthorized, "refresh token expired")
	}

	// Mint a fresh access token of the same kind as the presented refresh.
	var (
		access string
		user   *models.User
	)
	switch tok.Kind {
	case "user":
		u, err := s.users.FindByID(ctx, tok.SubjectID)
		if err != nil {
			return nil, apperr.Wrap(apperr.CodeInternal, "find user", err)
		}
		user = u
		access, err = s.issuer.IssueUser(u.ID, u.TenantID, string(u.Role))
		if err != nil {
			return nil, apperr.Wrap(apperr.CodeInternal, "issue user access", err)
		}
	case "device":
		var err error
		access, err = s.issuer.IssueDevice(tok.SubjectID, tok.TenantID)
		if err != nil {
			return nil, apperr.Wrap(apperr.CodeInternal, "issue device access", err)
		}
	default:
		return nil, apperr.New(apperr.CodeForbidden, "unknown token kind: "+tok.Kind)
	}

	newPlain, newHash, err := auth.NewRefreshToken()
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "issue refresh", err)
	}

	now := time.Now()
	newRT := &models.RefreshToken{
		ID:        uuid.New(),
		TenantID:  tok.TenantID,
		SubjectID: tok.SubjectID,
		Kind:      tok.Kind,
		TokenHash: newHash,
		IssuedAt:  now,
		ExpiresAt: now.Add(s.refreshTTL),
		UserAgent: ptr(userAgent),
		IPAddr:    ptr(ip),
	}
	if err := s.refresh.Insert(ctx, newRT); err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "persist refresh", err)
	}
	if err := s.refresh.Rotate(ctx, tok.ID, newRT.ID); err != nil {
		log.Warn().Err(err).Msg("rotate refresh failed")
	}
	return &TokenPair{Access: access, Refresh: newPlain, User: user}, nil
}

func (s *AuthService) Logout(ctx context.Context, plain string) error {
	tok, err := s.refresh.FindActive(ctx, auth.HashRefresh(plain))
	if err != nil {
		// Idempotent: missing token is success.
		return nil
	}
	return s.refresh.Revoke(ctx, tok.ID)
}

func (s *AuthService) Me(ctx context.Context, userID uuid.UUID) (*models.User, error) {
	return s.users.FindByID(ctx, userID)
}

func (s *AuthService) ListUsers(ctx context.Context, tenantID uuid.UUID) ([]models.User, error) {
	return s.users.ListByTenant(ctx, tenantID)
}

// CreateUser provisions a new admin user. The route gates this to user:manage
// (admin + super_admin); the actorRole hierarchy check below stops an admin
// from minting a user more privileged than themselves.
func (s *AuthService) CreateUser(ctx context.Context, tenantID, actorID uuid.UUID, actorRole, email, password, role string) (*models.User, error) {
	email = strings.TrimSpace(strings.ToLower(email))
	if !strings.Contains(email, "@") {
		return nil, apperr.New(apperr.CodeInvalidInput, "a valid email is required")
	}
	if len(password) < 8 {
		return nil, apperr.New(apperr.CodeInvalidInput, "password must be at least 8 characters")
	}
	if !authz.ValidRole(role) {
		return nil, apperr.New(apperr.CodeInvalidInput, "unknown role")
	}
	if !authz.CanManageRole(actorRole, role) {
		return nil, apperr.New(apperr.CodeForbidden, "you cannot create a user with a role above your own")
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "hash password", err)
	}
	u := &models.User{ID: uuid.New(), TenantID: tenantID, Email: email, PasswordHash: hash, Role: models.Role(role)}
	if err := s.users.CreateUser(ctx, u); err != nil {
		if errors.Is(err, repository.ErrEmailTaken) {
			return nil, apperr.New(apperr.CodeConflict, "that email is already in use")
		}
		return nil, apperr.Wrap(apperr.CodeInternal, "create user", err)
	}
	s.auditUser(ctx, tenantID, actorID, "user.created", u.ID, map[string]any{"email": email, "role": role})
	return u, nil
}

// UpdateUserRole changes a user's role. Guards against self-demotion and
// removing the tenant's last super_admin (both would risk a lockout).
func (s *AuthService) UpdateUserRole(ctx context.Context, tenantID, actorID uuid.UUID, actorRole string, targetID uuid.UUID, role string) error {
	if !authz.ValidRole(role) {
		return apperr.New(apperr.CodeInvalidInput, "unknown role")
	}
	target, err := s.users.FindByID(ctx, targetID)
	if err != nil {
		return apperr.New(apperr.CodeNotFound, "user not found")
	}
	if target.TenantID != tenantID {
		return apperr.New(apperr.CodeNotFound, "user not found")
	}
	// No escalation: can't modify a user above your rank, can't assign above it.
	if !authz.CanManageRole(actorRole, string(target.Role)) {
		return apperr.New(apperr.CodeForbidden, "you cannot modify a user with a higher role than your own")
	}
	if !authz.CanManageRole(actorRole, role) {
		return apperr.New(apperr.CodeForbidden, "you cannot assign a role above your own")
	}
	if targetID == actorID && role != authz.RoleSuperAdmin {
		return apperr.New(apperr.CodeInvalidInput, "you cannot remove your own super_admin role")
	}
	if string(target.Role) == authz.RoleSuperAdmin && role != authz.RoleSuperAdmin {
		n, _ := s.users.CountActiveSuperAdmins(ctx, tenantID)
		if n <= 1 {
			return apperr.New(apperr.CodeInvalidInput, "cannot demote the last super_admin")
		}
	}
	if err := s.users.UpdateRole(ctx, tenantID, targetID, role); err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return apperr.New(apperr.CodeNotFound, "user not found")
		}
		return apperr.Wrap(apperr.CodeInternal, "update role", err)
	}
	s.auditUser(ctx, tenantID, actorID, "user.role_changed", targetID, map[string]any{"role": role})
	return nil
}

// DeactivateUser soft-deletes a user. Guards self-deactivation and last super_admin.
func (s *AuthService) DeactivateUser(ctx context.Context, tenantID, actorID uuid.UUID, actorRole string, targetID uuid.UUID) error {
	if targetID == actorID {
		return apperr.New(apperr.CodeInvalidInput, "you cannot deactivate your own account")
	}
	target, err := s.users.FindByID(ctx, targetID)
	if err != nil || target.TenantID != tenantID {
		return apperr.New(apperr.CodeNotFound, "user not found")
	}
	if !authz.CanManageRole(actorRole, string(target.Role)) {
		return apperr.New(apperr.CodeForbidden, "you cannot deactivate a user with a higher role than your own")
	}
	if string(target.Role) == authz.RoleSuperAdmin {
		n, _ := s.users.CountActiveSuperAdmins(ctx, tenantID)
		if n <= 1 {
			return apperr.New(apperr.CodeInvalidInput, "cannot deactivate the last super_admin")
		}
	}
	if err := s.users.Deactivate(ctx, tenantID, targetID); err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return apperr.New(apperr.CodeNotFound, "user not found")
		}
		return apperr.Wrap(apperr.CodeInternal, "deactivate user", err)
	}
	s.auditUser(ctx, tenantID, actorID, "user.deactivated", targetID, nil)
	return nil
}

func (s *AuthService) auditUser(ctx context.Context, tenantID, actorID uuid.UUID, action string, targetID uuid.UUID, meta map[string]any) {
	var metaJSON []byte
	if meta != nil {
		metaJSON, _ = json.Marshal(meta)
	}
	events.Emit(ctx, s.bus, events.AuditEnvelope{
		TenantID:   tenantID.String(),
		ActorID:    events.UUIDStrPtr(actorID),
		ActorKind:  "user",
		Action:     action,
		TargetKind: events.StrPtr("user"),
		TargetID:   events.UUIDStrPtr(targetID),
		Metadata:   metaJSON,
	})
}

// ChangePassword verifies the user's current password before setting a new one.
func (s *AuthService) ChangePassword(ctx context.Context, userID uuid.UUID, oldPw, newPw string) error {
	if len(newPw) < 8 {
		return apperr.New(apperr.CodeInvalidInput, "new password must be at least 8 characters")
	}
	u, err := s.users.FindByID(ctx, userID)
	if err != nil {
		return apperr.Wrap(apperr.CodeInternal, "find user", err)
	}
	if !auth.VerifyPassword(u.PasswordHash, oldPw) {
		return apperr.New(apperr.CodeUnauthorized, "current password is incorrect")
	}
	hash, err := auth.HashPassword(newPw)
	if err != nil {
		return apperr.Wrap(apperr.CodeInternal, "hash password", err)
	}
	if err := s.users.UpdatePasswordHash(ctx, userID, hash); err != nil {
		return apperr.Wrap(apperr.CodeInternal, "update password", err)
	}
	return nil
}

// UpdateEmail changes the logged-in user's email (must be unique in tenant).
func (s *AuthService) UpdateEmail(ctx context.Context, userID uuid.UUID, email string) (*models.User, error) {
	email = strings.TrimSpace(email)
	if !strings.Contains(email, "@") || len(email) < 3 {
		return nil, apperr.New(apperr.CodeInvalidInput, "a valid email is required")
	}
	if err := s.users.UpdateEmail(ctx, userID, email); err != nil {
		if errors.Is(err, repository.ErrEmailTaken) {
			return nil, apperr.New(apperr.CodeConflict, "that email is already in use")
		}
		return nil, apperr.Wrap(apperr.CodeInternal, "update email", err)
	}
	return s.users.FindByID(ctx, userID)
}

func ptr[T any](v T) *T { return &v }
