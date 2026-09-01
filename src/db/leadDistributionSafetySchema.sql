-- Safety rules that sit around automatic lead distribution.
-- Kept separate from accessControlSchema.sql so the routing implementation stays
-- focused while these cross-feature invariants can evolve independently.

-- Centralized owner picker used by both new-lead assignment and conservative
-- recovery. The branch-routing toggle affects ownership only: branch data stays
-- on the lead for CRM/reporting even when every lead uses the global pool.
CREATE OR REPLACE FUNCTION choose_lead_distribution_owner(requested_branch TEXT DEFAULT NULL)
RETURNS TABLE(user_id INTEGER, owner_username TEXT, routing_scope TEXT) AS $$
DECLARE
  branch_routing_enabled BOOLEAN := true;
  route_branch TEXT := NULL;
  chosen_scope TEXT := 'global';
  eligible_count INTEGER := 0;
  previous_user_id INTEGER;
  selected_user_id INTEGER;
  selected_username TEXT;
BEGIN
  SELECT COALESCE(
    (
      SELECT COALESCE(data #>> '{leadDistribution,assignByBranch}', 'true') = 'true'
      FROM clinic_config
      WHERE id = 1
    ),
    true
  )
  INTO branch_routing_enabled;

  IF branch_routing_enabled = true
     AND NULLIF(btrim(COALESCE(requested_branch, '')), '') IS NOT NULL THEN
    route_branch := btrim(requested_branch);

    SELECT COUNT(*)::int
    INTO eligible_count
    FROM users
    WHERE is_active = true
      AND role = 'sales'
      AND lower(btrim(COALESCE(branch_name, ''))) = lower(route_branch)
      AND (
        COALESCE(permissions ->> 'view_assigned_leads', 'true') = 'true'
        OR COALESCE(permissions ->> 'view_all_leads', 'false') = 'true'
      )
      AND COALESCE(permissions ->> 'reply_to_assigned_leads', 'true') = 'true';

    IF eligible_count > 0 THEN
      chosen_scope := 'branch:' || lower(route_branch);
    ELSE
      route_branch := NULL;
    END IF;
  END IF;

  -- Branch routing disabled, branch missing, or branch without an eligible rep:
  -- use the full Sales pool while preserving the lead's branch record.
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
    chosen_scope := 'global';
  END IF;

  IF eligible_count = 0 THEN
    RETURN;
  END IF;

  IF eligible_count = 1 THEN
    SELECT id, username
    INTO selected_user_id, selected_username
    FROM users
    WHERE is_active = true
      AND role = 'sales'
      AND (
        route_branch IS NULL
        OR lower(btrim(COALESCE(branch_name, ''))) = lower(route_branch)
      )
      AND (
        COALESCE(permissions ->> 'view_assigned_leads', 'true') = 'true'
        OR COALESCE(permissions ->> 'view_all_leads', 'false') = 'true'
      )
      AND COALESCE(permissions ->> 'reply_to_assigned_leads', 'true') = 'true'
    ORDER BY id ASC
    LIMIT 1
    FOR SHARE;
  ELSE
    INSERT INTO lead_distribution_cursors (scope_key, last_user_id)
    VALUES (chosen_scope, NULL)
    ON CONFLICT (scope_key) DO NOTHING;

    SELECT last_user_id
    INTO previous_user_id
    FROM lead_distribution_cursors
    WHERE scope_key = chosen_scope
    FOR UPDATE;

    SELECT id, username
    INTO selected_user_id, selected_username
    FROM users
    WHERE is_active = true
      AND role = 'sales'
      AND (
        route_branch IS NULL
        OR lower(btrim(COALESCE(branch_name, ''))) = lower(route_branch)
      )
      AND (
        COALESCE(permissions ->> 'view_assigned_leads', 'true') = 'true'
        OR COALESCE(permissions ->> 'view_all_leads', 'false') = 'true'
      )
      AND COALESCE(permissions ->> 'reply_to_assigned_leads', 'true') = 'true'
      AND id > COALESCE(previous_user_id, 0)
    ORDER BY id ASC
    LIMIT 1
    FOR SHARE;

    IF selected_user_id IS NULL THEN
      SELECT id, username
      INTO selected_user_id, selected_username
      FROM users
      WHERE is_active = true
        AND role = 'sales'
        AND (
          route_branch IS NULL
          OR lower(btrim(COALESCE(branch_name, ''))) = lower(route_branch)
        )
        AND (
          COALESCE(permissions ->> 'view_assigned_leads', 'true') = 'true'
          OR COALESCE(permissions ->> 'view_all_leads', 'false') = 'true'
        )
        AND COALESCE(permissions ->> 'reply_to_assigned_leads', 'true') = 'true'
      ORDER BY id ASC
      LIMIT 1
      FOR SHARE;
    END IF;

    UPDATE lead_distribution_cursors
    SET last_user_id = selected_user_id,
        updated_at = now()
    WHERE scope_key = chosen_scope;
  END IF;

  IF selected_user_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT selected_user_id, selected_username, chosen_scope;
END;
$$ LANGUAGE plpgsql;

-- Override the base assignment function with the shared picker above. Existing
-- trigger bindings continue to use this CREATE OR REPLACE body.
CREATE OR REPLACE FUNCTION assign_new_lead_owner()
RETURNS TRIGGER AS $$
DECLARE
  distribution_enabled BOOLEAN := false;
  selected_user_id INTEGER;
  selected_username TEXT;
  selected_scope TEXT;
BEGIN
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

  SELECT COALESCE(
    (
      SELECT COALESCE(data #>> '{leadDistribution,enabled}', 'false') = 'true'
      FROM clinic_config
      WHERE id = 1
    ),
    false
  )
  INTO distribution_enabled;

  IF distribution_enabled IS DISTINCT FROM true THEN
    RETURN NEW;
  END IF;

  SELECT choice.user_id, choice.owner_username, choice.routing_scope
  INTO selected_user_id, selected_username, selected_scope
  FROM choose_lead_distribution_owner(NEW.branch_name) AS choice;

  IF selected_user_id IS NOT NULL THEN
    NEW.owner_username := selected_username;
    NEW.owner_assignment_source := 'automatic';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recovery uses the same routing toggle and pool picker as new lead creation.
-- A staff-cleared owner stays manual and can never be silently recovered.
CREATE OR REPLACE FUNCTION recover_unassigned_open_leads(max_leads INTEGER DEFAULT 100)
RETURNS INTEGER AS $$
DECLARE
  distribution_enabled BOOLEAN := false;
  safe_limit INTEGER := GREATEST(1, LEAST(COALESCE(max_leads, 100), 500));
  lead_record RECORD;
  selected_user_id INTEGER;
  selected_username TEXT;
  selected_scope TEXT;
  recovered_count INTEGER := 0;
BEGIN
  SELECT COALESCE(
    (
      SELECT COALESCE(data #>> '{leadDistribution,enabled}', 'false') = 'true'
      FROM clinic_config
      WHERE id = 1
    ),
    false
  )
  INTO distribution_enabled;

  IF distribution_enabled IS DISTINCT FROM true THEN
    RETURN 0;
  END IF;

  FOR lead_record IN
    SELECT id, branch_name
    FROM leads
    WHERE is_closed = false
      AND owner_username IS NULL
      AND owner_assignment_source IS NULL
    ORDER BY created_at ASC, id ASC
    LIMIT safe_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    selected_user_id := NULL;
    selected_username := NULL;
    selected_scope := NULL;

    SELECT choice.user_id, choice.owner_username, choice.routing_scope
    INTO selected_user_id, selected_username, selected_scope
    FROM choose_lead_distribution_owner(lead_record.branch_name) AS choice;

    -- No eligible global Sales account means later rows cannot be assigned either.
    IF selected_user_id IS NULL THEN
      EXIT;
    END IF;

    UPDATE leads
    SET owner_username = selected_username,
        owner_assignment_source = 'automatic',
        updated_at = now()
    WHERE id = lead_record.id
      AND is_closed = false
      AND owner_username IS NULL
      AND owner_assignment_source IS NULL;

    IF FOUND THEN
      INSERT INTO lead_activities (
        lead_id, activity_type, description, actor, metadata
      ) VALUES (
        lead_record.id,
        'updated',
        format('Previously unassigned lead automatically assigned to %s.', selected_username),
        'Lead distribution',
        jsonb_build_object(
          'source', 'lead_distribution_recovery',
          'ownerUsername', selected_username,
          'routingScope', selected_scope
        )
      );
      recovered_count := recovered_count + 1;
    END IF;
  END LOOP;

  RETURN recovered_count;
END;
$$ LANGUAGE plpgsql;

-- Any explicit or automatic owner must be an active staff account that can
-- actually see and reply to the lead. Lock the selected staff row so Team &
-- Access cannot make that owner ineligible in the same transaction window.
CREATE OR REPLACE FUNCTION validate_lead_owner_eligibility()
RETURNS TRIGGER AS $$
DECLARE
  selected_role TEXT;
  selected_permissions JSONB;
  selected_active BOOLEAN;
  can_view BOOLEAN := false;
  can_reply BOOLEAN := false;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.owner_username IS NOT DISTINCT FROM OLD.owner_username THEN
    RETURN NEW;
  END IF;

  NEW.owner_username := NULLIF(btrim(COALESCE(NEW.owner_username, '')), '');
  IF NEW.owner_username IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT role, permissions, is_active
  INTO selected_role, selected_permissions, selected_active
  FROM users
  WHERE username = NEW.owner_username
  FOR SHARE;

  IF NOT FOUND OR selected_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Lead owner "%" is not an active staff account. Choose an eligible owner.', NEW.owner_username
      USING ERRCODE = 'P0001';
  END IF;

  -- view_assigned_leads and reply_to_assigned_leads default to true for both
  -- current roles. view_all_leads defaults to true for Admin and false for Sales.
  can_view :=
    COALESCE((selected_permissions ->> 'view_assigned_leads')::boolean, true)
    OR COALESCE((selected_permissions ->> 'view_all_leads')::boolean, selected_role = 'admin');
  can_reply := COALESCE((selected_permissions ->> 'reply_to_assigned_leads')::boolean, true);

  IF can_view IS DISTINCT FROM true OR can_reply IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Lead owner "%" cannot currently view and reply to assigned leads. Choose an eligible owner.', NEW.owner_username
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_lead_owner_eligibility ON leads;
CREATE TRIGGER trg_validate_lead_owner_eligibility
BEFORE INSERT OR UPDATE OF owner_username ON leads
FOR EACH ROW
EXECUTE FUNCTION validate_lead_owner_eligibility();

-- A new or changed branch must be one of the clinic's currently configured
-- branch names. Historical stale values remain readable and can be preserved by
-- unrelated edits, but they cannot be newly selected for another lead.
CREATE OR REPLACE FUNCTION validate_current_lead_branch()
RETURNS TRIGGER AS $$
DECLARE
  requested_branch TEXT;
  canonical_branch TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.branch_name IS NOT DISTINCT FROM OLD.branch_name THEN
    RETURN NEW;
  END IF;

  requested_branch := NULLIF(btrim(COALESCE(NEW.branch_name, '')), '');
  IF requested_branch IS NULL THEN
    NEW.branch_name := NULL;
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
    RAISE EXCEPTION 'Lead branch "%" is no longer configured. Choose a current clinic branch or clear the branch.', requested_branch
      USING ERRCODE = 'P0001';
  END IF;

  NEW.branch_name := canonical_branch;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_current_lead_branch ON leads;
CREATE TRIGGER trg_validate_current_lead_branch
BEFORE INSERT OR UPDATE OF branch_name ON leads
FOR EACH ROW
EXECUTE FUNCTION validate_current_lead_branch();

-- Initial automatic ownership should be visible in Lead Activities just like a
-- later manual reassignment or recovery assignment. Keep this audit best-effort
-- so a logging problem can never block lead creation or the chatbot.
CREATE OR REPLACE FUNCTION log_initial_automatic_lead_assignment()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.owner_assignment_source = 'automatic' AND NEW.owner_username IS NOT NULL THEN
    BEGIN
      INSERT INTO lead_activities (
        lead_id, activity_type, description, actor, metadata
      ) VALUES (
        NEW.id,
        'updated',
        format('Automatically assigned to %s when the lead was created.', NEW.owner_username),
        'Lead distribution',
        jsonb_build_object(
          'source', 'lead_distribution_initial',
          'ownerUsername', NEW.owner_username,
          'branchName', NEW.branch_name
        )
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_log_initial_automatic_lead_assignment ON leads;
CREATE TRIGGER trg_log_initial_automatic_lead_assignment
AFTER INSERT ON leads
FOR EACH ROW
EXECUTE FUNCTION log_initial_automatic_lead_assignment();
