// Package storage wraps MinIO (S3-compatible) for blob persistence. We use
// presigned URLs for direct device downloads to avoid streaming bytes through
// our services.
package storage

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

const DefaultBucket = "mdm-files"

type Storage struct {
	cli    *minio.Client
	bucket string
}

func New(endpoint, accessKey, secretKey string, useSSL bool) (*Storage, error) {
	cli, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: useSSL,
	})
	if err != nil {
		return nil, err
	}
	return &Storage{cli: cli, bucket: DefaultBucket}, nil
}

func (s *Storage) EnsureBucket(ctx context.Context) error {
	ok, err := s.cli.BucketExists(ctx, s.bucket)
	if err != nil {
		return err
	}
	if ok {
		return nil
	}
	return s.cli.MakeBucket(ctx, s.bucket, minio.MakeBucketOptions{})
}

func (s *Storage) Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error {
	_, err := s.cli.PutObject(ctx, s.bucket, key, r, size, minio.PutObjectOptions{
		ContentType: contentType,
	})
	return err
}

func (s *Storage) PresignDownload(ctx context.Context, key string, ttl time.Duration) (string, error) {
	u, err := s.cli.PresignedGetObject(ctx, s.bucket, key, ttl, url.Values{})
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

func (s *Storage) Delete(ctx context.Context, key string) error {
	return s.cli.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{})
}

func KeyForApp(tenant, packageName string, versionCode int64) string {
	return fmt.Sprintf("apk/%s/%s/%d.apk", tenant, packageName, versionCode)
}
