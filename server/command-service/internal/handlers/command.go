package handlers

import (
	"encoding/json"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"github.com/mdm/command-service/internal/service"
	apperr "github.com/mdm/shared/errors"
	"github.com/mdm/shared/middleware"
)

type CommandHandler struct{ svc *service.CommandService }

func NewCommandHandler(s *service.CommandService) *CommandHandler { return &CommandHandler{svc: s} }

type createReq struct {
	DeviceID    string          `json:"device_id"`
	Kind        string          `json:"kind"`
	Payload     json.RawMessage `json:"payload,omitempty"`
	MaxAttempts int             `json:"max_attempts,omitempty"`
	TimeoutSec  int             `json:"timeout_sec,omitempty"`
}

func (h *CommandHandler) Create(c *fiber.Ctx) error {
	var req createReq
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed"})
	}
	devID, err := uuid.Parse(req.DeviceID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid device_id"})
	}
	timeout := time.Duration(req.TimeoutSec) * time.Second
	cmd, err := h.svc.Create(c.Context(), service.CreateInput{
		TenantID:    tenantOf(c),
		CreatedBy:   userOf(c),
		DeviceID:    devID,
		Kind:        req.Kind,
		Payload:     req.Payload,
		MaxAttempts: req.MaxAttempts,
		Timeout:     timeout,
	})
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.Status(201).JSON(cmd)
}

func (h *CommandHandler) Get(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	cmd, err := h.svc.Get(c.Context(), tenantOf(c), id)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(cmd)
}

func (h *CommandHandler) ListForDevice(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("deviceID"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid device id"})
	}
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	items, err := h.svc.ListForDevice(c.Context(), tenantOf(c), id, limit)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"items": items})
}

// Device-side: poll for pending commands (MQTT fallback).
func (h *CommandHandler) Poll(c *fiber.Ctx) error {
	devStr, _ := c.Locals(middleware.CtxDeviceID).(string)
	devID, err := uuid.Parse(devStr)
	if err != nil {
		return c.Status(401).JSON(fiber.Map{"error": "device required"})
	}
	limit, _ := strconv.Atoi(c.Query("limit", "16"))
	items, err := h.svc.Poll(c.Context(), devID, limit)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"items": items})
}

func (h *CommandHandler) Ack(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	if err := h.svc.Ack(c.Context(), id); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(204)
}

func (h *CommandHandler) Result(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	var req service.ResultInput
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed"})
	}
	if err := h.svc.Result(c.Context(), id, req); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(204)
}

func tenantOf(c *fiber.Ctx) uuid.UUID {
	s, _ := c.Locals(middleware.CtxTenantID).(string)
	t, _ := uuid.Parse(s)
	return t
}
func userOf(c *fiber.Ctx) uuid.UUID {
	s, _ := c.Locals(middleware.CtxUserID).(string)
	t, _ := uuid.Parse(s)
	return t
}
