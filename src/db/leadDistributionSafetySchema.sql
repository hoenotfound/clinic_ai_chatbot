-- Safety rules that sit around automatic lead distribution.
-- Kept separate from accessControlSchema.sql so the routing implementation stays
-- focused while these cross-feature invariants can evolve independently.

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
