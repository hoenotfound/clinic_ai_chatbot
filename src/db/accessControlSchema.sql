-- Role-based access control for management portal staff.
-- Existing logins predate roles, so promote them to admin on the first run to
-- preserve their current access. New accounts default to the restricted sales role.
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_name TEXT;

UPDATE users SET role = 'admin' WHERE role IS NULL;
UPDATE users SET display_name = username WHERE display_name IS NULL OR btrim(display_name) = '';

ALTER TABLE users ALTER COLUMN role SET DEFAULT 'sales';
ALTER TABLE users ALTER COLUMN role SET NOT NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'sales'));

CREATE INDEX IF NOT EXISTS idx_users_active_role ON users(is_active, role);
CREATE INDEX IF NOT EXISTS idx_users_sales_branch
  ON users(lower(branch_name), id)
  WHERE is_active = true AND role = 'sales';
CREATE INDEX IF NOT EXISTS idx_leads_owner_username
  ON leads(owner_username, is_closed, created_at DESC, id DESC);

-- Track whether ownership came from staff or from lead distribution. This lets
-- a later customer branch choice reroute only automatically assigned leads and
-- guarantees that a staff-selected owner is never overwritten.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS owner_assignment_source TEXT;
UPDATE leads
SET owner_assignment_source = 'manual'
WHERE owner_username IS NOT NULL
  AND owner_assignment_source IS NULL;
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_owner_assignment_source_check;
ALTER TABLE leads ADD CONSTRAINT leads_owner_assignment_source_check
  CHECK (owner_assignment_source IS NULL OR owner_assignment_source IN ('manual', 'automatic'));

-- Separate durable cursors keep the global fallback rotation independent from
-- each branch rotation. A branch with only one eligible Sales account does not
-- need a cursor at all.
CREATE TABLE IF NOT EXISTS lead_distribution_cursors (
  scope_key TEXT PRIMARY KEY,
  last_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Detect an explicit clinic branch mention from customer text. Matching is
-- deliberately conservative: if one message clearly names more than one branch
-- it returns NULL and waits for the customer to clarify rather than guessing.
-- Comma-separated branch names also get segment aliases, e.g.
-- "Sri Petaling, Kuala Lumpur" matches "Sri Petaling" and "Kuala Lumpur".
-- Common short forms such as PJ, SP and KL are derived from those segments.
CREATE OR REPLACE FUNCTION detect_configured_branch_preference(message_text TEXT)
RETURNS TEXT AS $$
DECLARE
  normalized_text TEXT;
  branch_record RECORD;
  normalized_name TEXT;
  primary_name TEXT;
  secondary_name TEXT;
  primary_acronym TEXT;
  secondary_acronym TEXT;
  aliases TEXT[];
  alias_value TEXT;
  matched_name TEXT := NULL;
BEGIN
  normalized_text := lower(regexp_replace(COALESCE(message_text, ''), '[^a-zA-Z0-9]+', ' ', 'g'));
  normalized_text := btrim(regexp_replace(normalized_text, '[[:space:]]+', ' ', 'g'));
  IF normalized_text = '' THEN
    RETURN NULL;
  END IF;
  normalized_text := ' ' || normalized_text || ' ';

  FOR branch_record IN
    SELECT branch ->> 'name' AS name
    FROM clinic_config
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(data -> 'branches', '[]'::jsonb)) AS branch
    WHERE id = 1
      AND NULLIF(btrim(branch ->> 'name'), '') IS NOT NULL
  LOOP
    normalized_name := btrim(regexp_replace(
      lower(branch_record.name), '[^a-zA-Z0-9]+', ' ', 'g'
    ));
    primary_name := btrim(regexp_replace(
      lower(split_part(branch_record.name, ',', 1)), '[^a-zA-Z0-9]+', ' ', 'g'
    ));
    secondary_name := btrim(regexp_replace(
      lower(split_part(branch_record.name, ',', 2)), '[^a-zA-Z0-9]+', ' ', 'g'
    ));

    SELECT string_agg(left(word, 1), '')
    INTO primary_acronym
    FROM regexp_split_to_table(primary_name, '[[:space:]]+') AS words(word)
    WHERE word <> '';

    SELECT string_agg(left(word, 1), '')
    INTO secondary_acronym
    FROM regexp_split_to_table(secondary_name, '[[:space:]]+') AS words(word)
    WHERE word <> '';

    aliases := ARRAY[normalized_name, primary_name];
    IF secondary_name <> '' THEN
      aliases := array_append(aliases, secondary_name);
    END IF;
    IF length(COALESCE(primary_acronym, '')) BETWEEN 2 AND 4 THEN
      aliases := array_append(aliases, primary_acronym);
    END IF;
    IF length(COALESCE(secondary_acronym, '')) BETWEEN 2 AND 4 THEN
      aliases := array_append(aliases, secondary_acronym);
    END IF;

    FOREACH alias_value IN ARRAY aliases LOOP
      IF alias_value <> ''
         AND position(' ' || alias_value || ' ' IN normalized_text) > 0 THEN
        IF matched_name IS NULL THEN
          matched_name := branch_record.name;
        ELSIF lower(matched_name) <> lower(branch_record.name) THEN
          RETURN NULL;
        END IF;
        EXIT;
      END IF;
    END LOOP;
  END LOOP;

  RETURN matched_name;
END;
$$ LANGUAGE plpgsql STABLE;

-- The old first-pass PR trigger used one global round-robin cursor. Replace it
-- with branch-first routing while keeping the old state table harmless if this
-- feature branch was ever deployed for testing.
DROP TRIGGER IF EXISTS trg_assign_lead_owner_round_robin ON leads;
DROP FUNCTION IF EXISTS assign_lead_owner_round_robin();

CREATE OR REPLACE FUNCTION route_lead_owner_by_branch()
RETURNS TRIGGER AS $$
DECLARE
  distribution_enabled BOOLEAN := false;
  target_branch TEXT;
  route_branch TEXT := NULL;
  routing_scope TEXT := 'global';
  eligible_count INTEGER := 0;
  previous_user_id INTEGER;
  selected_user_id INTEGER;
  selected_username TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- A staff/API owner change always wins, even if branch_name changes in the
    -- same UPDATE. Clearing an owner makes the lead eligible for future routing.
    IF NEW.owner_username IS DISTINCT FROM OLD.owner_username THEN
      NEW.owner_assignment_source := CASE
        WHEN NULLIF(btrim(COALESCE(NEW.owner_username, '')), '') IS NULL THEN NULL
        ELSE 'manual'
      END;
      RETURN NEW;
    END IF;

    IF NEW.branch_name IS NOT DISTINCT FROM OLD.branch_name THEN
      RETURN NEW;
    END IF;

    -- Customer/staff branch changes may reroute an unowned or automatically
    -- owned lead, but never a manually owned one.
    IF OLD.owner_username IS NOT NULL
       AND COALESCE(OLD.owner_assignment_source, 'manual') <> 'automatic' THEN
      RETURN NEW;
    END IF;
  ELSE
    -- Backfill is historical bookkeeping, not a new sales event.
    IF NEW.created_by = 'Migration' THEN
      RETURN NEW;
    END IF;

    IF NULLIF(btrim(COALESCE(NEW.owner_username, '')), '') IS NOT NULL THEN
      NEW.owner_assignment_source := 'manual';
      RETURN NEW;
    END IF;

    NEW.owner_username := NULL;
    NEW.owner_assignment_source := NULL;

    -- The first inbound message is already durable before the lead INSERT.
    -- Use it so a customer who starts with "PJ branch" enters that branch pool
    -- immediately and does not consume a turn from the global fallback pool.
    IF NULLIF(btrim(COALESCE(NEW.branch_name, '')), '') IS NULL THEN
      SELECT detect_configured_branch_preference(m.content)
      INTO target_branch
      FROM messages m
      WHERE m.contact_id = NEW.contact_id
        AND m.role = 'user'
      ORDER BY m.id DESC
      LIMIT 1;

      IF target_branch IS NOT NULL THEN
        NEW.branch_name := target_branch;
      END IF;
    END IF;
  END IF;

  SELECT COALESCE(data #>> '{leadDistribution,enabled}', 'false') = 'true'
  INTO distribution_enabled
  FROM clinic_config
  WHERE id = 1;

  IF distribution_enabled IS DISTINCT FROM true THEN
    RETURN NEW;
  END IF;

  target_branch := NULLIF(btrim(COALESCE(NEW.branch_name, '')), '');

  -- Branch first. If at least one eligible Sales account belongs to the chosen
  -- branch, restrict routing to that branch. Otherwise fall back to the global
  -- eligible Sales pool so a lead never gets stranded solely because staffing
  -- for one branch has not been configured yet.
  IF target_branch IS NOT NULL THEN
    SELECT COUNT(*)::int
    INTO eligible_count
    FROM users
    WHERE is_active = true
      AND role = 'sales'
      AND lower(btrim(COALESCE(branch_name, ''))) = lower(target_branch)
      AND (
        COALESCE(permissions ->> 'view_assigned_leads', 'true') = 'true'
        OR COALESCE(permissions ->> 'view_all_leads', 'false') = 'true'
      )
      AND COALESCE(permissions ->> 'reply_to_assigned_leads', 'true') = 'true';

    IF eligible_count > 0 THEN
      route_branch := target_branch;
      routing_scope := 'branch:' || lower(target_branch);
    END IF;
  END IF;

  IF route_branch IS NULL THEN
    SELECT COUNT(*)::int
    INTO eligible_count
    FROM users
    WHERE is_active = true
      AND role = 'sales'
      AND (
        COALESCE(permissions ->> 'view_assigned_leads', 'true') = 'true'
        OR COALESCE(permissions ->> 'view_all_leads', 'false') = 'true'
      )
      AND COALESCE(permissions ->> 'reply_to_assigned_leads', 'true') = 'true';
    routing_scope := 'global';
  END IF;

  IF eligible_count = 0 THEN
    RETURN NEW;
  END IF;

  -- One salesperson in a branch is a direct assignment, not a round-robin
  -- operation. Round robin is used only when the selected pool has 2+ accounts.
  IF eligible_count = 1 THEN
    SELECT id, username
    INTO selected_user_id, selected_username
    FROM users
    WHERE is_active = true
      AND role = 'sales'
      AND (route_branch IS NULL OR lower(btrim(COALESCE(branch_name, ''))) = lower(route_branch))
      AND (
        COALESCE(permissions ->> 'view_assigned_leads', 'true') = 'true'
        OR COALESCE(permissions ->> 'view_all_leads', 'false') = 'true'
      )
      AND COALESCE(permissions ->> 'reply_to_assigned_leads', 'true') = 'true'
    ORDER BY id ASC
    LIMIT 1;
  ELSE
    INSERT INTO lead_distribution_cursors (scope_key, last_user_id)
    VALUES (routing_scope, NULL)
    ON CONFLICT (scope_key) DO NOTHING;

    SELECT last_user_id
    INTO previous_user_id
    FROM lead_distribution_cursors
    WHERE scope_key = routing_scope
    FOR UPDATE;

    SELECT id, username
    INTO selected_user_id, selected_username
    FROM users
    WHERE is_active = true
      AND role = 'sales'
      AND (route_branch IS NULL OR lower(btrim(COALESCE(branch_name, ''))) = lower(route_branch))
      AND (
        COALESCE(permissions ->> 'view_assigned_leads', 'true') = 'true'
        OR COALESCE(permissions ->> 'view_all_leads', 'false') = 'true'
      )
      AND COALESCE(permissions ->> 'reply_to_assigned_leads', 'true') = 'true'
      AND id > COALESCE(previous_user_id, 0)
    ORDER BY id ASC
    LIMIT 1;

    IF selected_user_id IS NULL THEN
      SELECT id, username
      INTO selected_user_id, selected_username
      FROM users
      WHERE is_active = true
        AND role = 'sales'
        AND (route_branch IS NULL OR lower(btrim(COALESCE(branch_name, ''))) = lower(route_branch))
        AND (
          COALESCE(permissions ->> 'view_assigned_leads', 'true') = 'true'
          OR COALESCE(permissions ->> 'view_all_leads', 'false') = 'true'
        )
        AND COALESCE(permissions ->> 'reply_to_assigned_leads', 'true') = 'true'
      ORDER BY id ASC
      LIMIT 1;
    END IF;

    UPDATE lead_distribution_cursors
    SET last_user_id = selected_user_id, updated_at = now()
    WHERE scope_key = routing_scope;
  END IF;

  IF selected_user_id IS NOT NULL THEN
    NEW.owner_username := selected_username;
    NEW.owner_assignment_source := 'automatic';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_route_lead_owner_on_insert ON leads;
CREATE TRIGGER trg_route_lead_owner_on_insert
BEFORE INSERT ON leads
FOR EACH ROW
EXECUTE FUNCTION route_lead_owner_by_branch();

DROP TRIGGER IF EXISTS trg_route_lead_owner_on_change ON leads;
CREATE TRIGGER trg_route_lead_owner_on_change
BEFORE UPDATE OF branch_name, owner_username ON leads
FOR EACH ROW
EXECUTE FUNCTION route_lead_owner_by_branch();

-- Later customer messages can identify or change the preferred branch. Persist
-- that preference immediately; the lead UPDATE trigger above then reroutes only
-- automatically assigned leads. This also catches voice notes after their
-- placeholder message is replaced with the transcript.
CREATE OR REPLACE FUNCTION apply_customer_branch_preference()
RETURNS TRIGGER AS $$
DECLARE
  detected_branch TEXT;
BEGIN
  detected_branch := detect_configured_branch_preference(NEW.content);
  IF detected_branch IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE leads
  SET branch_name = detected_branch,
      updated_at = now()
  WHERE contact_id = NEW.contact_id
    AND is_closed = false
    AND branch_name IS DISTINCT FROM detected_branch;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customer_branch_after_message_insert ON messages;
CREATE TRIGGER trg_customer_branch_after_message_insert
AFTER INSERT ON messages
FOR EACH ROW
WHEN (NEW.role = 'user')
EXECUTE FUNCTION apply_customer_branch_preference();

DROP TRIGGER IF EXISTS trg_customer_branch_after_message_update ON messages;
CREATE TRIGGER trg_customer_branch_after_message_update
AFTER UPDATE OF content ON messages
FOR EACH ROW
WHEN (NEW.role = 'user' AND NEW.content IS DISTINCT FROM OLD.content)
EXECUTE FUNCTION apply_customer_branch_preference();
