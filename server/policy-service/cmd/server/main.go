package main

import (
	"context"
	"errors"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/rs/zerolog/log"

	"github.com/mdm/policy-service/internal/handlers"
	"github.com/mdm/policy-service/internal/repository"
	"github.com/mdm/policy-service/internal/service"
	"github.com/mdm/shared/auth"
	"github.com/mdm/shared/config"
	"github.com/mdm/shared/db"
	"github.com/mdm/shared/logger"
	"github.com/mdm/shared/middleware"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		panic(err)
	}
	logger.Init(cfg.ServiceName, cfg.Env, cfg.LogLevel)

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	pg, err := db.Open(ctx, cfg.PostgresDSN)
	if err != nil {
		log.Fatal().Err(err).Msg("db")
	}
	defer pg.Close()

	issuer := auth.NewIssuer(cfg.JWTSecret, cfg.JWTAccessTTL)
	repo := repository.NewPolicyRepo(pg)
	svc := service.NewPolicyService(repo)
	h := handlers.NewPolicyHandler(svc)

	app := fiber.New(fiber.Config{
		AppName: "mdm-policy", DisableStartupMessage: true,
		ReadTimeout: 20 * time.Second, WriteTimeout: 20 * time.Second,
	})
	app.Use(middleware.RequestLogger(), middleware.Recover(), middleware.Metrics(cfg.ServiceName))

	app.Get("/healthz", func(c *fiber.Ctx) error { return c.SendString("ok") })

	admin := app.Group("/api/v1/policies", middleware.JWTAuth(issuer), middleware.TenantScope())
	admin.Get("/", h.List)
	admin.Post("/", middleware.RequireRole("super_admin", "admin"), h.Upsert)
	admin.Get("/:id", h.Get)
	admin.Get("/:id/diff", h.Diff)
	admin.Post("/:id/versions", middleware.RequireRole("super_admin", "admin"), h.Upsert)
	admin.Post("/assign", middleware.RequireRole("super_admin", "admin"), h.Assign)

	// Device-facing assigned-policy retrieval.
	app.Get("/api/v1/policies/assigned",
		middleware.JWTAuth(issuer), middleware.RequireDevice(), middleware.TenantScope(), h.AssignedForDevice)

	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		_ = (&http.Server{Addr: ":9100", Handler: mux, ReadHeaderTimeout: 5 * time.Second}).ListenAndServe()
	}()

	go func() {
		if err := app.Listen(":8003"); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal().Err(err).Msg("listen")
		}
	}()
	log.Info().Msg("policy-service started on :8003")
	<-ctx.Done()
	c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = app.ShutdownWithContext(c)
}
