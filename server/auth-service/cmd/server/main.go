// auth-service: issues, refreshes, and revokes tokens for admin users and
// enrolled devices. Owns the users + refresh_tokens tables.
package main

import (
	"context"
	"errors"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jmoiron/sqlx"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/rs/zerolog/log"

	"github.com/mdm/auth-service/internal/handlers"
	"github.com/mdm/auth-service/internal/repository"
	"github.com/mdm/auth-service/internal/service"
	"github.com/mdm/shared/auth"
	"github.com/mdm/shared/cache"
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
		log.Fatal().Err(err).Msg("db connect")
	}
	defer pg.Close()

	rdb := cache.New(cfg.RedisAddr)
	defer rdb.Close()

	issuer := auth.NewIssuer(cfg.JWTSecret, cfg.JWTAccessTTL)

	app := newApp(cfg.ServiceName, pg, rdb, issuer, cfg.JWTRefreshTTL)

	// Prometheus on a separate port to keep it off the public path.
	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		srv := &http.Server{Addr: ":9100", Handler: mux, ReadHeaderTimeout: 5 * time.Second}
		_ = srv.ListenAndServe()
	}()

	addr := ":" + itoa(cfg.HTTPPort)
	go func() {
		if err := app.Listen(addr); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal().Err(err).Msg("listen")
		}
	}()
	log.Info().Str("addr", addr).Msg("auth-service started")

	<-ctx.Done()
	log.Info().Msg("shutdown signal received")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	_ = app.ShutdownWithContext(shutdownCtx)
}

func newApp(svc string, pg *sqlx.DB, rdb interface{}, issuer *auth.Issuer, refreshTTL time.Duration) *fiber.App {
	app := fiber.New(fiber.Config{
		AppName:               "mdm-auth",
		DisableStartupMessage: true,
		ReadTimeout:           15 * time.Second,
		WriteTimeout:          15 * time.Second,
	})

	app.Use(middleware.RequestLogger())
	app.Use(middleware.Recover())
	app.Use(middleware.Metrics(svc))

	userRepo := repository.NewUserRepo(pg)
	refreshRepo := repository.NewRefreshRepo(pg)

	authSvc := service.NewAuthService(userRepo, refreshRepo, issuer, refreshTTL)
	authH := handlers.NewAuthHandler(authSvc)

	app.Get("/healthz", func(c *fiber.Ctx) error { return c.SendString("ok") })
	app.Get("/readyz", func(c *fiber.Ctx) error {
		if err := pg.PingContext(c.Context()); err != nil {
			return c.Status(503).SendString("postgres down")
		}
		return c.SendString("ok")
	})

	v1 := app.Group("/api/v1/auth")
	v1.Post("/login", authH.Login)
	v1.Post("/refresh", authH.Refresh)
	v1.Post("/logout", authH.Logout)
	v1.Get("/me", middleware.JWTAuth(issuer), authH.Me)

	return app
}

func itoa(i int) string {
	const digits = "0123456789"
	if i == 0 {
		return "0"
	}
	b := make([]byte, 0, 5)
	for i > 0 {
		b = append([]byte{digits[i%10]}, b...)
		i /= 10
	}
	return string(b)
}
