// Package middleware provides HTTP middlewares used across services.
package middleware

import (
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/mdm/shared/auth"
)

const (
	CtxClaims   = "claims"
	CtxTenantID = "tenantID"
	CtxUserID   = "userID"
	CtxDeviceID = "deviceID"
)

// JWTAuth verifies the bearer token using the supplied issuer and rejects
// requests with missing or invalid tokens. The verified Claims are placed in
// fiber locals under CtxClaims.
func JWTAuth(issuer *auth.Issuer) fiber.Handler {
	return func(c *fiber.Ctx) error {
		h := c.Get("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "missing bearer token"})
		}
		raw := strings.TrimPrefix(h, "Bearer ")
		claims, err := issuer.Parse(raw)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid token"})
		}
		c.Locals(CtxClaims, claims)
		c.Locals(CtxTenantID, claims.TenantID)
		if claims.Kind == auth.KindUser {
			c.Locals(CtxUserID, claims.Subject)
		} else {
			c.Locals(CtxDeviceID, claims.Subject)
		}
		return c.Next()
	}
}

// RequireRole enforces RBAC for admin-side endpoints.
func RequireRole(roles ...string) fiber.Handler {
	allowed := make(map[string]struct{}, len(roles))
	for _, r := range roles {
		allowed[r] = struct{}{}
	}
	return func(c *fiber.Ctx) error {
		claims, _ := c.Locals(CtxClaims).(*auth.Claims)
		if claims == nil || claims.Kind != auth.KindUser {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "user token required"})
		}
		if _, ok := allowed[claims.Role]; !ok {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "insufficient role"})
		}
		return c.Next()
	}
}

// RequireDevice ensures the caller is a device token.
func RequireDevice() fiber.Handler {
	return func(c *fiber.Ctx) error {
		claims, _ := c.Locals(CtxClaims).(*auth.Claims)
		if claims == nil || claims.Kind != auth.KindDevice {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "device token required"})
		}
		return c.Next()
	}
}
