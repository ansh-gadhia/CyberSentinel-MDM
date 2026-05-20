package handlers

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/rs/zerolog/log"

	"github.com/mdm/file-service/internal/repository"
	"github.com/mdm/file-service/internal/storage"
	"github.com/mdm/shared/middleware"
	"github.com/mdm/shared/models"
)

type Handler struct {
	repo  *repository.FileRepo
	store *storage.Storage
}

func New(r *repository.FileRepo, s *storage.Storage) *Handler { return &Handler{repo: r, store: s} }

// Upload streams a multipart file into MinIO and records metadata. Admin path —
// the uploader is the authenticated user.
func (h *Handler) Upload(c *fiber.Ctx) error {
	return h.upload(c, false)
}

// DeviceUpload is the device-authenticated counterpart used for camera
// captures and log bundles. Files are tied to the calling device's id.
func (h *Handler) DeviceUpload(c *fiber.Ctx) error {
	return h.upload(c, true)
}

func (h *Handler) upload(c *fiber.Ctx, byDevice bool) error {
	mf, err := c.FormFile("file")
	if err != nil {
		log.Warn().Err(err).Msg("upload: FormFile parse failed")
		return c.Status(400).JSON(fiber.Map{"error": "file form field required: " + err.Error()})
	}
	kind := c.FormValue("kind", "generic")
	name := c.FormValue("name", mf.Filename)
	tenantID := tenantOf(c)

	f, err := mf.Open()
	if err != nil {
		log.Error().Err(err).Msg("upload: form open failed")
		return c.Status(500).JSON(fiber.Map{"error": "open form: " + err.Error()})
	}
	defer f.Close()

	h1 := sha256.New()
	pr, pw := io.Pipe()
	errCh := make(chan error, 1)
	go func() {
		defer pw.Close()
		_, err := io.Copy(io.MultiWriter(h1, pw), f)
		errCh <- err
	}()

	storageKey := fmt.Sprintf("%s/%s/%s", kind, tenantID, uuid.NewString())
	if err := h.store.Put(c.Context(), storageKey, pr, mf.Size, mf.Header.Get("Content-Type")); err != nil {
		log.Error().Err(err).Str("key", storageKey).Int64("size", mf.Size).Msg("upload: MinIO Put failed")
		return c.Status(500).JSON(fiber.Map{"error": "store: " + err.Error()})
	}
	if err := <-errCh; err != nil {
		log.Error().Err(err).Msg("upload: hash copy failed")
		return c.Status(500).JSON(fiber.Map{"error": "hash: " + err.Error()})
	}

	obj := &models.FileObject{
		TenantID:    tenantID,
		Name:        name,
		Kind:        kind,
		StorageKey:  storageKey,
		SHA256:      hex.EncodeToString(h1.Sum(nil)),
		SizeBytes:   mf.Size,
		ContentType: mf.Header.Get("Content-Type"),
	}
	if byDevice {
		did := deviceOf(c)
		obj.UploadedByDevice = &did
		obj.DeviceID = &did
	} else {
		uid := userOf(c)
		obj.UploadedBy = &uid
		if dStr := c.FormValue("device_id"); dStr != "" {
			if d, err := uuid.Parse(dStr); err == nil {
				obj.DeviceID = &d
			}
		}
	}
	if err := h.repo.Insert(c.Context(), obj); err != nil {
		log.Error().Err(err).Str("kind", kind).Str("name", name).Msg("upload: DB persist failed")
		return c.Status(500).JSON(fiber.Map{"error": "persist: " + err.Error()})
	}
	return c.Status(201).JSON(obj)
}

func (h *Handler) List(c *fiber.Ctx) error {
	filt := repository.ListFilter{TenantID: tenantOf(c), Kind: c.Query("kind")}
	if s := c.Query("device_id"); s != "" {
		if d, err := uuid.Parse(s); err == nil {
			filt.DeviceID = &d
		}
	}
	out, err := h.repo.List(c.Context(), filt)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"items": out})
}

// Presign returns a short-lived download URL for a stored object.
//
// Host selection: the URL is signed against whatever host the admin browser
// is currently reaching the server at (X-Forwarded-Host from our admin nginx,
// falling back to the Host header on the inbound request). This means a
// laptop on the office LAN, a phone tethered to cellular, and a remote VPN
// client all get a URL that resolves on THEIR network without any static
// MINIO_PUBLIC_ENDPOINT reconfiguration. The companion nginx location at
// `/mdm-files/` proxies the actual byte-range request to the internal
// minio:9000 endpoint while preserving Host so the SigV4 check passes.
func (h *Handler) Presign(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	obj, err := h.repo.Get(c.Context(), tenantOf(c), id)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "not found"})
	}
	pubEndpoint := publicEndpointFromRequest(c)
	url, err := h.store.PresignDownloadFor(c.Context(), obj.StorageKey, 10*time.Minute, pubEndpoint)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"url": url, "expires_in": 600, "sha256": obj.SHA256, "size": obj.SizeBytes})
}

// publicEndpointFromRequest returns "scheme://host[:port]" the admin's
// browser used to hit the API, or "" if nothing useful is on the request.
// nginx's proxy.inc sets both X-Forwarded-Host and X-Forwarded-Proto.
func publicEndpointFromRequest(c *fiber.Ctx) string {
	host := c.Get("X-Forwarded-Host")
	if host == "" {
		host = c.Hostname()
	}
	if host == "" {
		return ""
	}
	proto := c.Get("X-Forwarded-Proto")
	if proto == "" {
		proto = "http"
	}
	return proto + "://" + host
}

func (h *Handler) Delete(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	if err := h.repo.SoftDelete(c.Context(), tenantOf(c), id); err != nil {
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
func deviceOf(c *fiber.Ctx) uuid.UUID {
	s, _ := c.Locals(middleware.CtxDeviceID).(string)
	t, _ := uuid.Parse(s)
	return t
}
