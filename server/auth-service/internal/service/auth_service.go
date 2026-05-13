// Package service holds the auth use cases: login, refresh, logout, identity.
// The handler layer is a thin adapter to HTTP; business logic lives here.
package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"

	"github.com/mdm/auth-service/internal/repository"
	"github.com/mdm/shared/auth"
	apperr "github.com/mdm/shared/errors"
	"github.com/mdm/shared/models"
)

type AuthService struct {
	users      *repository.UserRepo
	refresh    *repository.RefreshRepo
	issuer     *auth.Issuer
	refreshTTL time.Duration
}

func NewAuthService(u *repository.UserRepo, r *repository.RefreshRepo, iss *auth.Issuer, refreshTTL time.Duration) *AuthService {
	return &AuthService{users: u, refresh: r, issuer: iss, refreshTTL: refreshTTL}
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

func ptr[T any](v T) *T { return &v }
