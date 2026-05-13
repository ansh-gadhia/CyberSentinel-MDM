package handlers

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

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

// Upload streams a multipart file into MinIO and records metadata.
func (h *Handler) Upload(c *fiber.Ctx) error {
	mf, err := c.FormFile("file")
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "file form field required"})
	}
	kind := c.FormValue("kind", "generic")
	name := c.FormValue("name", mf.Filename)
	tenantID := tenantOf(c)
	userID := userOf(c)

	f, err := mf.Open()
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "open form: " + err.Error()})
	}
	defer f.Close()

	// We must compute sha256 while streaming. To avoid buffering the whole APK
	// in memory we tee through a hasher into a pipe, but MinIO's SDK needs a
	// Reader with known size. Simplest correct approach: write to disk-backed
	// tmp file or use TeeReader against an in-memory buffer. For real-world
	// APK sizes (50–200MB) a TeeReader into a temp file is best — kept simple
	// here with a single read pass.
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
		return c.Status(500).JSON(fiber.Map{"error": "store: " + err.Error()})
	}
	if err := <-errCh; err != nil {
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
		UploadedBy:  userID,
	}
	if err := h.repo.Insert(c.Context(), obj); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "persist: " + err.Error()})
	}
	return c.Status(201).JSON(obj)
}

func (h *Handler) List(c *fiber.Ctx) error {
	out, err := h.repo.List(c.Context(), tenantOf(c), c.Query("kind"))
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"items": out})
}

// Presign returns a short-lived download URL for a stored object.
func (h *Handler) Presign(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	obj, err := h.repo.Get(c.Context(), tenantOf(c), id)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "not found"})
	}
	url, err := h.store.PresignDownload(c.Context(), obj.StorageKey, 10*time.Minute)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"url": url, "expires_in": 600, "sha256": obj.SHA256, "size": obj.SizeBytes})
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
