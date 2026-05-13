package handlers

import (
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"github.com/mdm/auth-service/internal/dto"
	"github.com/mdm/auth-service/internal/service"
	apperr "github.com/mdm/shared/errors"
	"github.com/mdm/shared/middleware"
)

type AuthHandler struct{ svc *service.AuthService }

func NewAuthHandler(s *service.AuthService) *AuthHandler { return &AuthHandler{svc: s} }

func (h *AuthHandler) Login(c *fiber.Ctx) error {
	var req dto.LoginRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed body"})
	}
	if req.Email == "" || req.Password == "" {
		return c.Status(400).JSON(fiber.Map{"error": "email and password required"})
	}

	pair, err := h.svc.Login(c.Context(), service.LoginInput{
		Email:     req.Email,
		Password:  req.Password,
		UserAgent: c.Get("User-Agent"),
		IP:        c.IP(),
	})
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}

	resp := dto.LoginResponse{
		AccessToken:  pair.Access,
		RefreshToken: pair.Refresh,
		ExpiresIn:    int((15 * 60)), // mirror JWT_ACCESS_TTL default
		TokenType:    "Bearer",
	}
	resp.User.ID = pair.User.ID.String()
	resp.User.Email = pair.User.Email
	resp.User.Role = string(pair.User.Role)
	resp.User.TenantID = pair.User.TenantID.String()
	return c.JSON(resp)
}

func (h *AuthHandler) Refresh(c *fiber.Ctx) error {
	var req dto.RefreshRequest
	if err := c.BodyParser(&req); err != nil || req.RefreshToken == "" {
		return c.Status(400).JSON(fiber.Map{"error": "refresh_token required"})
	}
	pair, err := h.svc.Refresh(c.Context(), req.RefreshToken, c.Get("User-Agent"), c.IP())
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(dto.RefreshResponse{
		AccessToken:  pair.Access,
		RefreshToken: pair.Refresh,
		ExpiresIn:    15 * 60,
		TokenType:    "Bearer",
	})
}

func (h *AuthHandler) Logout(c *fiber.Ctx) error {
	var req dto.RefreshRequest
	_ = c.BodyParser(&req)
	if req.RefreshToken != "" {
		_ = h.svc.Logout(c.Context(), req.RefreshToken)
	}
	return c.SendStatus(204)
}

func (h *AuthHandler) Me(c *fiber.Ctx) error {
	uidStr, _ := c.Locals(middleware.CtxUserID).(string)
	id, err := uuid.Parse(uidStr)
	if err != nil {
		return c.Status(401).JSON(fiber.Map{"error": "no user"})
	}
	u, err := h.svc.Me(c.Context(), id)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(dto.MeResponse{
		ID:       u.ID.String(),
		Email:    u.Email,
		Role:     string(u.Role),
		TenantID: u.TenantID.String(),
	})
}
