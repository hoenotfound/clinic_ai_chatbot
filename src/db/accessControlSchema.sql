-- Role-based access control for management portal staff.
-- Existing logins predate roles, so promote them to admin on the first run to
-- preserve their current access. New accounts default to the restricted sales role.
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

UPDATE users SET role = 'admin' WHERE role IS NULL;
UPDATE users SET display_name = username WHERE display_name IS NULL OR btrim(display_name) = '';

ALTER TABLE users ALTER COLUMN role SET DEFAULT 'sales';
ALTER TABLE users ALTER COLUMN role SET NOT NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'sales'));

CREATE INDEX IF NOT EXISTS idx_users_active_role ON users(is_active, role);
CREATE INDEX IF NOT EXISTS idx_leads_owner_username
  ON leads(owner_username, is_closed, created_at DESC, id DESC);
