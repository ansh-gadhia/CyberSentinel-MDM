package main

import (
	"context"
	"errors"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/rs/zerolog/log"

	"github.com/mdm/command-service/internal/dispatcher"
	"github.com/mdm/command-service/internal/handlers"
	"github.com/mdm/command-service/internal/repository"
	"github.com/mdm/command-service/internal/service"
	"github.com/mdm/shared/auth"
	"github.com/mdm/shared/authz"
	"github.com/mdm/shared/config"
	"github.com/mdm/shared/db"
	"github.com/mdm/shared/logger"
	"github.com/mdm/shared/middleware"
	"github.com/mdm/shared/mq"
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
	repo := repository.NewCommandRepo(pg)
	bus, err := mq.Connect(cfg.NATSUrl)
	if err != nil {
		log.Warn().Err(err).Msg("nats connect — audit events will be dropped")
	}
	svc := service.NewCommandService(repo, bus)
	h := handlers.NewCommandHandler(svc)

	mqttOpts := mqtt.NewClientOptions().
		AddBroker(cfg.MQTTBroker).
		SetClientID("command-service-" + uuid.NewString()).
		SetUsername(cfg.MQTTUser).
		SetPassword(cfg.MQTTPass).
		SetAutoReconnect(true).
		SetCleanSession(true).
		SetConnectTimeout(5 * time.Second)
	mqttClient := mqtt.NewClient(mqttOpts)
	if tok := mqttClient.Connect(); !tok.WaitTimeout(10*time.Second) || tok.Error() != nil {
		log.Warn().Err(tok.Error()).Msg("mqtt connect — continuing; dispatcher will reconnect")
	}
	disp := dispatcher.New(repo, mqttClient)
	go disp.Run(ctx)

	app := fiber.New(fiber.Config{
		AppName: "mdm-command", DisableStartupMessage: true,
		ReadTimeout: 20 * time.Second, WriteTimeout: 20 * time.Second,
	})
	app.Use(middleware.RequestLogger(), middleware.Recover(), middleware.Metrics(cfg.ServiceName))
	app.Get("/healthz", func(c *fiber.Ctx) error { return c.SendString("ok") })

	admin := app.Group("/api/v1/commands", middleware.JWTAuth(issuer), middleware.TenantScope())
	// Baseline gate: any role that can issue commands at all (operator+). The
	// per-command-kind risk tier (basic / privileged / surveillance) is then
	// enforced inside the handler via authz.CommandPermission — so an operator
	// can LOCK/locate but not WIPE or start a covert audio stream.
	admin.Post("/", middleware.RequirePermission(authz.PermCommandBasic), h.Create)
	admin.Post("/broadcast", middleware.RequirePermission(authz.PermCommandBasic), h.Broadcast)
	admin.Get("/:id", middleware.RequirePermission(authz.PermCommandRead), h.Get)
	admin.Get("/by-device/:deviceID", middleware.RequirePermission(authz.PermCommandRead), h.ListForDevice)

	dev := app.Group("/api/v1/commands", middleware.JWTAuth(issuer))
	dev.Get("/poll", middleware.RequireDevice(), h.Poll)
	dev.Post("/:id/ack", middleware.RequireDevice(), h.Ack)
	dev.Post("/:id/result", middleware.RequireDevice(), h.Result)

	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		_ = (&http.Server{Addr: ":9100", Handler: mux, ReadHeaderTimeout: 5 * time.Second}).ListenAndServe()
	}()
	go func() {
		if err := app.Listen(":8004"); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal().Err(err).Msg("listen")
		}
	}()
	log.Info().Msg("command-service started on :8004")
	<-ctx.Done()
	mqttClient.Disconnect(500)
	c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = app.ShutdownWithContext(c)
}
