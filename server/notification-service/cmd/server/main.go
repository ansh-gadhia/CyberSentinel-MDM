package main

import (
	"context"
	"errors"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/gofiber/contrib/websocket"
	mqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/rs/zerolog/log"

	"github.com/mdm/notification-service/internal/bridge"
	"github.com/mdm/notification-service/internal/ws"
	"github.com/mdm/shared/auth"
	"github.com/mdm/shared/config"
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

	bus, err := mq.Connect(cfg.NATSUrl)
	if err != nil {
		log.Fatal().Err(err).Msg("nats")
	}
	_ = bus.EnsureStreams()

	mqttOpts := mqtt.NewClientOptions().
		AddBroker(cfg.MQTTBroker).
		SetClientID("notif-" + uuid.NewString()).
		SetUsername(cfg.MQTTUser).
		SetPassword(cfg.MQTTPass).
		SetAutoReconnect(true)
	mc := mqtt.NewClient(mqttOpts)
	if tok := mc.Connect(); !tok.WaitTimeout(10*time.Second) || tok.Error() != nil {
		log.Warn().Err(tok.Error()).Msg("mqtt; will reconnect in background")
	}

	hub := ws.NewHub()
	br := bridge.New(bus.JS, mc, hub)
	go func() {
		if err := br.Run(ctx); err != nil {
			log.Error().Err(err).Msg("bridge")
		}
	}()

	issuer := auth.NewIssuer(cfg.JWTSecret, cfg.JWTAccessTTL)

	app := fiber.New(fiber.Config{
		AppName: "mdm-notification", DisableStartupMessage: true,
	})
	app.Use(middleware.RequestLogger(), middleware.Recover(), middleware.Metrics(cfg.ServiceName))
	app.Get("/healthz", func(c *fiber.Ctx) error { return c.SendString("ok") })

	app.Use("/ws", func(c *fiber.Ctx) error {
		// Admin auth via Sec-WebSocket-Protocol header (browser-friendly: clients
		// send "Bearer <jwt>" as a subprotocol). The first token after "Bearer "
		// is parsed and validated.
		token := c.Get("Sec-WebSocket-Protocol")
		if len(token) > 7 && token[:7] == "Bearer " {
			token = token[7:]
		}
		claims, err := issuer.Parse(token)
		if err != nil {
			return c.SendStatus(401)
		}
		c.Locals("tenant", claims.TenantID)
		if websocket.IsWebSocketUpgrade(c) {
			return c.Next()
		}
		return c.SendStatus(fiber.StatusUpgradeRequired)
	})

	app.Get("/ws", websocket.New(func(c *websocket.Conn) {
		tenant, _ := c.Locals("tenant").(string)
		hub.Register(c, tenant)
		defer hub.Unregister(c)
		// Block on read so the connection stays open. Discard incoming.
		for {
			if _, _, err := c.ReadMessage(); err != nil {
				return
			}
		}
	}))

	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		_ = (&http.Server{Addr: ":9100", Handler: mux, ReadHeaderTimeout: 5 * time.Second}).ListenAndServe()
	}()
	go func() {
		if err := app.Listen(":8006"); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal().Err(err).Msg("listen")
		}
	}()
	log.Info().Msg("notification-service started on :8006")
	<-ctx.Done()
	c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = app.ShutdownWithContext(c)
	mc.Disconnect(500)
}
