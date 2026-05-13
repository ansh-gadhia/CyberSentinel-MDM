package handlers

import (
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"github.com/mdm/device-service/internal/dto"
	"github.com/mdm/device-service/internal/service"
	apperr "github.com/mdm/shared/errors"
	"github.com/mdm/shared/middleware"
)

type EnrollmentHandler struct{ svc *service.EnrollmentService }

func NewEnrollmentHandler(s *service.EnrollmentService) *EnrollmentHandler {
	return &EnrollmentHandler{svc: s}
}

func (h *EnrollmentHandler) CreateToken(c *fiber.Ctx) error {
	var req dto.CreateEnrollmentTokenRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed body"})
	}
	tenantStr, _ := c.Locals(middleware.CtxTenantID).(string)
	tenantID, _ := uuid.Parse(tenantStr)
	userStr, _ := c.Locals(middleware.CtxUserID).(string)
	userID, _ := uuid.Parse(userStr)

	ttl, _ := time.ParseDuration(req.ExpiresIn)
	var policyID *uuid.UUID
	if req.PolicyID != nil {
		p, err := uuid.Parse(*req.PolicyID)
		if err == nil {
			policyID = &p
		}
	}
	resp, err := h.svc.CreateToken(c.Context(), service.CreateTokenInput{
		TenantID: tenantID, CreatedBy: userID, PolicyID: policyID,
		OneShot: req.OneShot, MaxUses: req.MaxUses, TTL: ttl,
	})
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.Status(201).JSON(resp)
}

func (h *EnrollmentHandler) QRPayload(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("tokenID"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid token id"})
	}
	payload, err := h.svc.BuildQRPayload(c.Context(), id)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(payload)
}

func (h *EnrollmentHandler) Enroll(c *fiber.Ctx) error {
	var req dto.EnrollRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed body"})
	}
	resp, err := h.svc.Enroll(c.Context(), req)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.Status(201).JSON(resp)
}
