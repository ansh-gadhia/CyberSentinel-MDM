-- 009_seed.sql
-- Seeds a default tenant and a super-admin user for local development.
-- Password: ChangeMe!123  (bcrypt cost 12)
-- WARNING: replace this user before exposing the deployment to the internet.

INSERT INTO tenants (id, slug, name) VALUES
    ('00000000-0000-0000-0000-000000000001'::uuid, 'default', 'Default Tenant')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES
    (
      '00000000-0000-0000-0000-000000000010'::uuid,
      '00000000-0000-0000-0000-000000000001'::uuid,
      'admin@mdm.local',
      -- bcrypt hash of "ChangeMe!123" (cost 12)
      '$2b$12$4beCLiGfNsWDcZmLUZbcmOFMhGLbb7jZoT6YYMUeXmPb/8I/phPZa',
      'super_admin'
    )
ON CONFLICT (tenant_id, email) DO NOTHING;
