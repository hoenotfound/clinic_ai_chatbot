-- Role-based access control for management portal staff.
-- Existing logins predate roles, so promote them to admin on the first run to
-- preserve their current access. New accounts default to the restricted sales role.
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;

UPDATE users SET role = 'admin' WHERE role IS NULL;
UPDATE users SET display_name = username WHERE display_name IS NULL OR btrim(display_name) = '';

ALTER TABLE users ALTER COLUMN role SET DEFAULT 'sales';
ALTER TABLE users ALTER COLUMN role SET NOT NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'sales'));

CREATE INDEX IF NOT EXISTS idx_users_active_role ON users(is_active, role);
CREATE INDEX IF NOT EXISTS idx_leads_owner_username
  ON leads(owner_username, is_closed, created_at DESC, id DESC);

-- One durable cursor is enough for round-robin lead distribution. The row is
-- locked inside each lead INSERT transaction, so simultaneous webhooks cannot
-- pick the same salesperson merely because they arrived at the same moment.
CREATE TABLE IF NOT EXISTS lead_distribution_state (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  last_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lead_distribution_state_single_row CHECK (id = 1)
);

INSERT INTO lead_distribution_state (id, last_user_id)
VALUES (1, NULL)
ON CONFLICT (id) DO NOTHING;

-- Assign only previously unowned leads. Explicit staff ownership is always
-- preserved. Eligibility is evaluated for every new lead so disabled accounts
-- and accounts changed away from the Sales role immediately leave the pool.
CREATE OR REPLACE FUNCTION assign_lead_owner_round_robin()
RETURNS TRIGGER AS $$
DECLARE
  distribution_enabled BOOLEAN := false;
  previous_user_id INTEGER;
  selected_user_id INTEGER;
  selected_username TEXT;
BEGIN
  IF NEW.owner_username IS NOT NULL AND btrim(NEW.owner_username) <> '' THEN
    RETURN NEW;
  END IF;
  NEW.owner_username := NULL;

  SELECT COALESCE((data #>> '{leadDistribution,enabled}')::boolean, false)
  INTO distribution_enabled
  FROM clinic_config
  WHERE id = 1;

  IF distribution_enabled IS DISTINCT FROM true THEN
    RETURN NEW;
  END IF;

  -- Locking the singleton state row serializes only the very small section
  -- that chooses the next rep. If the lead INSERT later rolls back, this cursor
  -- update rolls back with it, so the rotation cannot accidentally skip a turn.
  SELECT last_user_id
  INTO previous_user_id
  FROM lead_distribution_state
  WHERE id = 1
  FOR UPDATE;

  SELECT id, username
  INTO selected_user_id, selected_username
  FROM users
  WHERE is_active = true
    AND role = 'sales'
    AND id > COALESCE(previous_user_id, 0)
  ORDER BY id ASC
  LIMIT 1;

  IF selected_user_id IS NULL THEN
    SELECT id, username
    INTO selected_user_id, selected_username
    FROM users
    WHERE is_active = true
      AND role = 'sales'
    ORDER BY id ASC
    LIMIT 1;
  END IF;

  -- No eligible Sales account means the lead stays unassigned. The chatbot
  -- continues normally and the admin can assign it manually later.
  IF selected_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.owner_username := selected_username;
  UPDATE lead_distribution_state
  SET last_user_id = selected_user_id, updated_at = now()
  WHERE id = 1;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_assign_lead_owner_round_robin ON leads;
CREATE TRIGGER trg_assign_lead_owner_round_robin
BEFORE INSERT ON leads
FOR EACH ROW
EXECUTE FUNCTION assign_lead_owner_round_robin();
