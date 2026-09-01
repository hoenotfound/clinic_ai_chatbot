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

-- Track whether ownership came from staff or from lead distribution. Ownership
-- is intentionally independent from the branch record: once a lead has an owner,
-- a later AI/staff branch correction never moves the conversation to another rep.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS owner_assignment_source TEXT;
UPDATE leads
SET owner_assignment_source = 'manual'
WHERE owner_username IS NOT NULL
  AND owner_assignment_source IS NULL;
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_owner_assignment_source_check;
ALTER TABLE leads ADD CONSTRAINT leads_owner_assignment_source_check
  CHECK (owner_assignment_source IS NULL OR owner_assignment_source IN ('manual', 'automatic'));

-- Separate durable cursors keep the global rotation independent from each branch
-- rotation. Branch routing is used only when a structured branch is already known
-- at lead creation. Normal inbound leads without one start in the global rotation.
CREATE TABLE IF NOT EXISTS lead_distribution_cursors (
  scope_key TEXT PRIMARY KEY,
  last_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Remove the earlier text-matching/rerouting implementation if this feature
-- branch was deployed for testing. Customer messages must never carry routing
-- triggers: a lead-assignment failure must not be able to fail message storage.
DROP TRIGGER IF EXISTS trg_assign_lead_owner_round_robin ON leads;
DROP TRIGGER IF EXISTS trg_route_lead_owner_on_insert ON leads;
DROP TRIGGER IF EXISTS trg_route_lead_owner_on_change ON leads;
DROP TRIGGER IF EXISTS trg_customer_branch_after_message_insert ON messages;
DROP TRIGGER IF EXISTS trg_customer_branch_after_message_update ON messages;
DROP FUNCTION IF EXISTS assign_lead_owner_round_robin();
DROP FUNCTION IF EXISTS apply_customer_branch_preference();
DROP FUNCTION IF EXISTS detect_configured_branch_preference(TEXT);
DROP FUNCTION IF EXISTS route_lead_owner_by_branch();

CREATE OR REPLACE FUNCTION assign_new_lead_owner()
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
  -- Backfill is historical bookkeeping, not a new sales event.
  IF NEW.created_by = 'Migration' THEN
    RETURN NEW;
  END IF;

  -- Explicit ownership always wins and is never part of an automatic rotation.
  IF NULLIF(btrim(COALESCE(NEW.owner_username, '')), '') IS NOT NULL THEN
    NEW.owner_assignment_source := 'manual';
    RETURN NEW;
  END IF;

  NEW.owner_username := NULL;
  NEW.owner_assignment_source := NULL;

  SELECT COALESCE(data #>> '{leadDistribution,enabled}', 'false') = 'true'
  INTO distribution_enabled
  FROM clinic_config
  WHERE id = 1;

  IF distribution_enabled IS DISTINCT FROM true THEN
    RETURN NEW;
  END IF;

  target_branch := NULLIF(btrim(COALESCE(NEW.branch_name, '')), '');

  -- Use branch-first routing only when another trusted workflow already supplied
  -- a structured branch before the lead is inserted (for example a manual lead).
  -- We deliberately do not infer a branch from arbitrary customer text here.
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

  -- If no branch was known, or a pre-set branch currently has no eligible rep,
  -- keep the lead moving through the global Sales pool instead of blocking chat.
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

  -- A one-person pool is a direct assignment. Round robin is only meaningful
  -- when the selected pool contains two or more eligible Sales accounts.
  -- KEY SHARE pairs with Team & Access FOR UPDATE locks so a selected rep cannot
  -- be disabled or lose eligibility in the middle of this lead INSERT.
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
    LIMIT 1
    FOR KEY SHARE;
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
    LIMIT 1
    FOR KEY SHARE;

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
      LIMIT 1
      FOR KEY SHARE;
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

DROP TRIGGER IF EXISTS trg_assign_new_lead_owner ON leads;
CREATE TRIGGER trg_assign_new_lead_owner
BEFORE INSERT ON leads
FOR EACH ROW
EXECUTE FUNCTION assign_new_lead_owner();

-- Any later explicit owner change is a staff/API decision. Mark it manual so
-- future assignment features can continue to respect it. Branch edits are not
-- part of this trigger and therefore never affect owner_username.
CREATE OR REPLACE FUNCTION mark_manual_lead_owner_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.owner_username IS DISTINCT FROM OLD.owner_username THEN
    NEW.owner_assignment_source := CASE
      WHEN NULLIF(btrim(COALESCE(NEW.owner_username, '')), '') IS NULL THEN NULL
      ELSE 'manual'
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mark_manual_lead_owner_change ON leads;
CREATE TRIGGER trg_mark_manual_lead_owner_change
BEFORE UPDATE OF owner_username ON leads
FOR EACH ROW
EXECUTE FUNCTION mark_manual_lead_owner_change();

-- The existing AI conversation summary returns preferredBranch. The prompt now
-- canonicalizes a clear customer preference to one exact configured branch name.
-- This remains soft CRM enrichment only: fill a blank branch and never touch owner.
-- Staff corrections remain authoritative because non-blank branch records are kept.
CREATE OR REPLACE FUNCTION fill_lead_branch_from_ai_summary()
RETURNS TRIGGER AS $$
DECLARE
  requested_branch TEXT;
  canonical_branch TEXT;
  updated_lead_id INTEGER;
BEGIN
  IF NEW.status <> 'completed' THEN
    RETURN NEW;
  END IF;

  requested_branch := NULLIF(btrim(COALESCE(NEW.summary_data ->> 'preferredBranch', '')), '');
  IF requested_branch IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT branch ->> 'name'
  INTO canonical_branch
  FROM clinic_config
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(data -> 'branches', '[]'::jsonb)) AS branch
  WHERE id = 1
    AND lower(btrim(branch ->> 'name')) = lower(requested_branch)
  LIMIT 1;

  IF canonical_branch IS NULL THEN
    RETURN NEW;
  END IF;

  -- Branch enrichment is deliberately isolated from scoring. If anything about
  -- the lead update fails, preserve the completed score and simply skip enrichment.
  BEGIN
    UPDATE leads
    SET branch_name = canonical_branch,
        updated_at = now()
    WHERE id = NEW.lead_id
      AND NULLIF(btrim(COALESCE(branch_name, '')), '') IS NULL
    RETURNING id INTO updated_lead_id;
  EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
  END;

  -- Record where the branch came from when it was actually filled. Activity
  -- logging is best-effort and must never undo the branch update above.
  IF updated_lead_id IS NOT NULL THEN
    BEGIN
      INSERT INTO lead_activities (
        lead_id, activity_type, description, actor, metadata
      ) VALUES (
        updated_lead_id,
        'updated',
        format('AI summary recorded preferred branch: %s.', canonical_branch),
        'AI summary',
        jsonb_build_object(
          'source', 'ai_summary',
          'scoreId', NEW.id,
          'throughMessageId', NEW.through_message_id,
          'preferredBranch', canonical_branch
        )
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fill_lead_branch_from_ai_summary ON lead_temperature_scores;
CREATE TRIGGER trg_fill_lead_branch_from_ai_summary
AFTER UPDATE OF status, summary_data ON lead_temperature_scores
FOR EACH ROW
WHEN (NEW.status = 'completed')
EXECUTE FUNCTION fill_lead_branch_from_ai_summary();
