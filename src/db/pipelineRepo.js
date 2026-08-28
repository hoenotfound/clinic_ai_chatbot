const { pool } = require("./db");
const realtimeEvents = require("../utils/realtimeEvents");

const NO_REPLY_HOURS = 24;

function publishPipelineChange(leadId = null) {
  realtimeEvents.publish("pipeline_changed", { leadId });
}

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function addActivity(client, leadId, activityType, description, actor, metadata = {}) {
  await client.query(
    `INSERT INTO lead_activities (lead_id, activity_type, description, actor, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [leadId, activityType, description, actor, metadata]
  );
}

async function listStages(queryable = pool) {
  const result = await queryable.query(
    `SELECT id, name, sort_order, color, stage_type, system_key,
            (SELECT COUNT(*)::int FROM leads WHERE stage_id = pipeline_stages.id) AS lead_count
     FROM pipeline_stages
     ORDER BY sort_order ASC, id ASC`
  );
  return result.rows;
}

async function getStageById(id, queryable = pool) {
  const result = await queryable.query(
    `SELECT id, name, sort_order, color, stage_type, system_key
     FROM pipeline_stages WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

const LEAD_SELECT = `
  SELECT
    l.id, l.contact_id, l.stage_id, l.notes, l.temperature, l.branch_name,
    l.owner_username, l.treatment_interest, l.estimated_value, l.source,
    l.campaign_name, l.appointment_status, l.appointment_at,
    l.next_follow_up_at, l.lost_reason, l.marketing_consent, l.is_closed,
    l.closed_at, l.created_by, l.created_at, l.updated_at,
    s.name AS stage_name, s.color AS stage_color, s.stage_type, s.system_key,
    c.whatsapp_number, c.name, c.whatsapp_profile_name, c.channel, c.photo_url,
    c.mode, c.needs_attention, c.needs_follow_up, c.is_unread,
    latest.content AS last_message, latest.role AS last_message_role,
    latest.created_at AS last_message_at,
    latest.delivery_status AS last_message_delivery_status,
    COALESCE(stage_change.created_at, l.created_at) AS stage_entered_at,
    (
      NOT l.is_closed
      AND latest.role = 'assistant'
      AND (
        latest.delivery_status IS NULL
        OR latest.delivery_status IN ('pending', 'sent', 'delivered', 'read')
      )
      AND latest.created_at <= now() - (${NO_REPLY_HOURS} * interval '1 hour')
    ) AS no_reply
  FROM leads l
  JOIN pipeline_stages s ON s.id = l.stage_id
  JOIN contacts c ON c.id = l.contact_id
  LEFT JOIN LATERAL (
    SELECT m.content, m.role, m.created_at, m.delivery_status
    FROM messages m
    WHERE m.contact_id = l.contact_id
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  ) latest ON true
  LEFT JOIN LATERAL (
    SELECT h.created_at
    FROM lead_stage_history h
    WHERE h.lead_id = l.id AND h.to_stage_id = l.stage_id
    ORDER BY h.created_at DESC, h.id DESC
    LIMIT 1
  ) stage_change ON true
`;

async function listLeads() {
  const result = await pool.query(`${LEAD_SELECT} ORDER BY l.updated_at DESC, l.id DESC`);
  return result.rows;
}

async function getLeadById(id) {
  const result = await pool.query(`${LEAD_SELECT} WHERE l.id = $1`, [id]);
  return result.rows[0] || null;
}

async function getActiveLeadForContact(contactId, queryable = pool) {
  const result = await queryable.query(
    `SELECT l.*, s.name AS stage_name, s.stage_type, s.system_key
     FROM leads l
     JOIN pipeline_stages s ON s.id = l.stage_id
     WHERE l.contact_id = $1 AND l.is_closed = false
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT 1`,
    [contactId]
  );
  return result.rows[0] || null;
}

async function ensureLeadForContact(contactId, actor = "Automation") {
  const outcome = await withTransaction(async (client) => {
    const existing = await getActiveLeadForContact(contactId, client);
    if (existing) return { lead: existing, created: false };

    const stageResult = await client.query(
      `SELECT id, name FROM pipeline_stages
       WHERE stage_type = 'open'
       ORDER BY sort_order ASC, id ASC
       LIMIT 1`
    );
    const stage = stageResult.rows[0];
    if (!stage) {
      const err = new Error("Add at least one open pipeline stage first.");
      err.code = "NO_OPEN_STAGE";
      throw err;
    }

    const inserted = await client.query(
      `INSERT INTO leads (contact_id, stage_id, created_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (contact_id) WHERE is_closed = false DO NOTHING
       RETURNING *`,
      [contactId, stage.id, actor]
    );

    if (!inserted.rows[0]) {
      return { lead: await getActiveLeadForContact(contactId, client), created: false };
    }

    const lead = inserted.rows[0];
    await client.query(
      `INSERT INTO lead_stage_history (lead_id, from_stage_id, to_stage_id, changed_by)
       VALUES ($1, NULL, $2, $3)`,
      [lead.id, stage.id, actor]
    );
    await addActivity(client, lead.id, "created", `Lead created in ${stage.name}.`, actor);
    return { lead, created: true };
  });

  if (outcome.created) publishPipelineChange(outcome.lead.id);
  return outcome;
}

async function markContactedForContact(contactId, actor = "Automation") {
  const movedLeadId = await withTransaction(async (client) => {
    const currentResult = await client.query(
      `SELECT l.id, l.stage_id, s.name AS stage_name, s.system_key
       FROM leads l
       JOIN pipeline_stages s ON s.id = l.stage_id
       WHERE l.contact_id = $1 AND l.is_closed = false
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT 1
       FOR UPDATE OF l`,
      [contactId]
    );
    const current = currentResult.rows[0];

    // Do not reopen completed journeys or pull leads backwards after staff
    // have already progressed them beyond the initial stage.
    if (!current || current.system_key !== "new") return null;

    const contactedResult = await client.query(
      `SELECT id, name
       FROM pipeline_stages
       WHERE system_key = 'contacted' AND stage_type = 'open'
       LIMIT 1`
    );
    const contacted = contactedResult.rows[0];
    if (!contacted || Number(contacted.id) === Number(current.stage_id)) return null;

    await client.query(
      `UPDATE leads SET stage_id = $1, updated_at = now() WHERE id = $2`,
      [contacted.id, current.id]
    );
    await client.query(
      `INSERT INTO lead_stage_history (lead_id, from_stage_id, to_stage_id, changed_by)
       VALUES ($1, $2, $3, $4)`,
      [current.id, current.stage_id, contacted.id, actor]
    );
    await addActivity(
      client,
      current.id,
      "stage",
      `Moved from ${current.stage_name} to ${contacted.name} after a message was sent.`,
      actor,
      { fromStageId: current.stage_id, toStageId: contacted.id }
    );
    return current.id;
  });

  if (movedLeadId) publishPipelineChange(movedLeadId);
  return Boolean(movedLeadId);
}

async function backfillLeadsForExistingContacts() {
  const inserted = await withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO leads (contact_id, stage_id, created_by)
       SELECT c.id, first_stage.id, 'Migration'
       FROM contacts c
       CROSS JOIN LATERAL (
         SELECT id FROM pipeline_stages
         WHERE stage_type = 'open'
         ORDER BY sort_order ASC, id ASC
         LIMIT 1
       ) first_stage
       WHERE EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = c.id)
         AND NOT EXISTS (SELECT 1 FROM leads existing WHERE existing.contact_id = c.id)
       ON CONFLICT (contact_id) WHERE is_closed = false DO NOTHING
       RETURNING id, stage_id`,
    );

    for (const lead of result.rows) {
      await client.query(
        `INSERT INTO lead_stage_history (lead_id, from_stage_id, to_stage_id, changed_by)
         VALUES ($1, NULL, $2, 'Migration')`,
        [lead.id, lead.stage_id]
      );
      await addActivity(
        client,
        lead.id,
        "created",
        "Existing conversation added to the pipeline.",
        "Migration"
      );
    }
    return result.rows;
  });

  if (inserted.length) publishPipelineChange();
  return inserted.length;
}

async function createLead(data, actor) {
  const outcome = await withTransaction(async (client) => {
    const existing = await getActiveLeadForContact(data.contactId, client);
    if (existing) return { lead: existing, created: false };

    const stage = data.stageId
      ? await getStageById(data.stageId, client)
      : (await client.query(
          `SELECT id, name, stage_type, system_key FROM pipeline_stages
           WHERE stage_type = 'open' ORDER BY sort_order ASC, id ASC LIMIT 1`
        )).rows[0];
    if (!stage) {
      const err = new Error("Pipeline stage not found.");
      err.code = "INVALID_STAGE";
      throw err;
    }

    const isClosed = stage.stage_type !== "open";
    const result = await client.query(
      `INSERT INTO leads (
         contact_id, stage_id, temperature, branch_name, owner_username,
         treatment_interest, estimated_value, source, campaign_name,
         appointment_status, appointment_at, next_follow_up_at,
         marketing_consent, is_closed, closed_at, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               CASE WHEN $14 THEN now() ELSE NULL END, $15)
       ON CONFLICT (contact_id) WHERE is_closed = false DO NOTHING
       RETURNING *`,
      [
        data.contactId,
        stage.id,
        data.temperature || "warm",
        data.branchName || null,
        data.ownerUsername || null,
        data.treatmentInterest || null,
        data.estimatedValue ?? null,
        data.source || null,
        data.campaignName || null,
        data.appointmentStatus || "none",
        data.appointmentAt || null,
        data.nextFollowUpAt || null,
        data.marketingConsent || "unknown",
        isClosed,
        actor,
      ]
    );
    const lead = result.rows[0];
    if (!lead) {
      return {
        lead: await getActiveLeadForContact(data.contactId, client),
        created: false,
      };
    }
    await client.query(
      `INSERT INTO lead_stage_history (lead_id, from_stage_id, to_stage_id, changed_by)
       VALUES ($1, NULL, $2, $3)`,
      [lead.id, stage.id, actor]
    );
    await addActivity(client, lead.id, "created", `Lead created in ${stage.name}.`, actor);
    return { lead, created: true };
  });

  if (outcome.created) publishPipelineChange(outcome.lead.id);
  return outcome;
}

const PATCH_COLUMNS = {
  temperature: "temperature",
  branchName: "branch_name",
  ownerUsername: "owner_username",
  treatmentInterest: "treatment_interest",
  estimatedValue: "estimated_value",
  source: "source",
  campaignName: "campaign_name",
  appointmentStatus: "appointment_status",
  appointmentAt: "appointment_at",
  nextFollowUpAt: "next_follow_up_at",
  lostReason: "lost_reason",
  marketingConsent: "marketing_consent",
  notes: "notes",
};

function describeChanges(current, patch) {
  const descriptions = [];
  if (Object.hasOwn(patch, "temperature") && patch.temperature !== current.temperature) descriptions.push(`Temperature set to ${patch.temperature}.`);
  if (Object.hasOwn(patch, "branchName") && (patch.branchName || null) !== (current.branch_name || null)) descriptions.push(patch.branchName ? `Assigned to ${patch.branchName}.` : "Branch assignment cleared.");
  if (Object.hasOwn(patch, "ownerUsername") && (patch.ownerUsername || null) !== (current.owner_username || null)) descriptions.push(patch.ownerUsername ? `Owner changed to ${patch.ownerUsername}.` : "Lead owner cleared.");
  if (Object.hasOwn(patch, "treatmentInterest") && (patch.treatmentInterest || null) !== (current.treatment_interest || null)) descriptions.push(patch.treatmentInterest ? `Treatment interest set to ${patch.treatmentInterest}.` : "Treatment interest cleared.");
  if (Object.hasOwn(patch, "estimatedValue") && Number(patch.estimatedValue || 0) !== Number(current.estimated_value || 0)) descriptions.push(patch.estimatedValue == null ? "Estimated value cleared." : `Estimated value set to RM ${Number(patch.estimatedValue).toFixed(2)}.`);
  if (Object.hasOwn(patch, "source") && (patch.source || null) !== (current.source || null)) descriptions.push(patch.source ? `Lead source set to ${patch.source}.` : "Lead source cleared.");
  if (Object.hasOwn(patch, "campaignName") && (patch.campaignName || null) !== (current.campaign_name || null)) descriptions.push(patch.campaignName ? `Campaign set to ${patch.campaignName}.` : "Campaign cleared.");
  if (Object.hasOwn(patch, "appointmentStatus") && patch.appointmentStatus !== current.appointment_status) descriptions.push(`Appointment status changed to ${patch.appointmentStatus}.`);
  if (Object.hasOwn(patch, "appointmentAt") && dateValue(patch.appointmentAt) !== dateValue(current.appointment_at)) descriptions.push(patch.appointmentAt ? "Appointment date updated." : "Appointment date cleared.");
  if (Object.hasOwn(patch, "nextFollowUpAt") && dateValue(patch.nextFollowUpAt) !== dateValue(current.next_follow_up_at)) descriptions.push(patch.nextFollowUpAt ? "Next follow-up scheduled." : "Next follow-up cleared.");
  if (Object.hasOwn(patch, "lostReason") && (patch.lostReason || null) !== (current.lost_reason || null)) descriptions.push(patch.lostReason ? `Lost reason: ${patch.lostReason}.` : "Lost reason cleared.");
  if (Object.hasOwn(patch, "marketingConsent") && patch.marketingConsent !== current.marketing_consent) descriptions.push(`Marketing consent set to ${patch.marketingConsent}.`);
  if (Object.hasOwn(patch, "notes") && patch.notes !== current.notes) descriptions.push("Lead notes updated.");
  return descriptions.join(" ");
}

function dateValue(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

async function updateLead(id, patch, actor) {
  const updatedLead = await withTransaction(async (client) => {
    const currentResult = await client.query(
      `SELECT l.*, s.name AS stage_name, s.stage_type, s.system_key
       FROM leads l JOIN pipeline_stages s ON s.id = l.stage_id
       WHERE l.id = $1 FOR UPDATE`,
      [id]
    );
    const current = currentResult.rows[0];
    if (!current) return null;

    const changes = { ...patch };
    let nextStage = null;
    if (Object.hasOwn(changes, "stageId")) {
      nextStage = await getStageById(changes.stageId, client);
      if (!nextStage) {
        const err = new Error("Pipeline stage not found.");
        err.code = "INVALID_STAGE";
        throw err;
      }

      const stageChanged = Number(current.stage_id) !== Number(nextStage.id);
      if (stageChanged) {
        changes.isClosed = nextStage.stage_type !== "open";
        changes.closedAt = changes.isClosed ? new Date().toISOString() : null;
        if (nextStage.stage_type === "lost" && !changes.lostReason && !current.lost_reason) {
          changes.lostReason = "Not specified";
        } else if (nextStage.stage_type !== "lost") {
          changes.lostReason = null;
        }
        if (nextStage.system_key === "appointment_set" && !Object.hasOwn(changes, "appointmentStatus")) {
          changes.appointmentStatus = "set";
        }
        if (nextStage.system_key === "visited" && !Object.hasOwn(changes, "appointmentStatus")) {
          changes.appointmentStatus = "visited";
        }
      }
    }

    const setters = [];
    const values = [];
    function addSetter(column, value) {
      values.push(value);
      setters.push(`${column} = $${values.length}`);
    }

    if (Object.hasOwn(changes, "stageId")) addSetter("stage_id", changes.stageId);
    for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
      if (Object.hasOwn(changes, key)) addSetter(column, changes[key]);
    }
    if (Object.hasOwn(changes, "isClosed")) addSetter("is_closed", changes.isClosed);
    if (Object.hasOwn(changes, "closedAt")) addSetter("closed_at", changes.closedAt);
    if (!setters.length) return current;

    values.push(id);
    const result = await client.query(
      `UPDATE leads SET ${setters.join(", ")}, updated_at = now()
       WHERE id = $${values.length} RETURNING *`,
      values
    );

    if (nextStage && Number(current.stage_id) !== Number(nextStage.id)) {
      await client.query(
        `INSERT INTO lead_stage_history (lead_id, from_stage_id, to_stage_id, changed_by)
         VALUES ($1, $2, $3, $4)`,
        [id, current.stage_id, nextStage.id, actor]
      );
      await addActivity(
        client,
        id,
        "stage",
        `Moved from ${current.stage_name} to ${nextStage.name}.`,
        actor,
        { fromStageId: current.stage_id, toStageId: nextStage.id }
      );
    }

    const description = describeChanges(current, changes);
    if (description) await addActivity(client, id, "updated", description, actor);
    return result.rows[0];
  });

  if (updatedLead) publishPipelineChange(updatedLead.id);
  return updatedLead;
}

async function applyAutomaticTemperature(id, suggestion) {
  if (
    !suggestion ||
    suggestion.enoughInformation !== true ||
    suggestion.confidence !== "high" ||
    !["hot", "cold"].includes(suggestion.temperature)
  ) {
    return null;
  }

  const updatedLead = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE leads
       SET temperature = $2, updated_at = now()
       WHERE id = $1 AND is_closed = false AND temperature = 'warm'
       RETURNING *`,
      [id, suggestion.temperature]
    );
    const updated = result.rows[0];
    if (!updated) return null;

    const nextTemperature = suggestion.temperature === "hot" ? "Hot" : "Cold";
    await addActivity(
      client,
      id,
      "updated",
      `AI automatically changed the temperature from Warm to ${nextTemperature}. ${suggestion.reason}`,
      "AI automation",
      {
        source: "conversation_temperature",
        confidence: suggestion.confidence,
        reason: suggestion.reason,
      }
    );
    return updated;
  });

  if (updatedLead) publishPipelineChange(updatedLead.id);
  return updatedLead;
}

async function listActivities(leadId) {
  const result = await pool.query(
    `SELECT id, activity_type, description, actor, metadata, created_at
     FROM lead_activities WHERE lead_id = $1
     ORDER BY created_at DESC, id DESC`,
    [leadId]
  );
  return result.rows;
}

async function addNote(leadId, content, actor) {
  const activity = await withTransaction(async (client) => {
    const lead = await client.query("SELECT id FROM leads WHERE id = $1", [leadId]);
    if (!lead.rows[0]) return null;
    const result = await client.query(
      `INSERT INTO lead_activities (lead_id, activity_type, description, actor)
       VALUES ($1, 'note', $2, $3)
       RETURNING id, activity_type, description, actor, metadata, created_at`,
      [leadId, content, actor]
    );
    await client.query("UPDATE leads SET updated_at = now() WHERE id = $1", [leadId]);
    return result.rows[0];
  });
  if (activity) publishPipelineChange(leadId);
  return activity;
}

async function createStage({ name, color, stageType }) {
  const result = await pool.query(
    `INSERT INTO pipeline_stages (name, color, stage_type, sort_order)
     SELECT $1, $2, $3, COALESCE((SELECT MAX(sort_order) FROM pipeline_stages), 0) + 10
     WHERE NOT EXISTS (SELECT 1 FROM pipeline_stages WHERE lower(name) = lower($1))
     RETURNING id, name, sort_order, color, stage_type, system_key`,
    [name, color, stageType]
  );
  if (!result.rows[0]) {
    const err = new Error("A stage with that name already exists.");
    err.code = "DUPLICATE_STAGE";
    throw err;
  }
  publishPipelineChange();
  return result.rows[0];
}

async function updateStage(id, patch) {
  const updated = await withTransaction(async (client) => {
    const current = await getStageById(id, client);
    if (!current) return null;

    if (patch.stageType && patch.stageType !== current.stage_type) {
      if (current.system_key) {
        const err = new Error("Built-in stages keep their workflow type so lead automation continues to work.");
        err.code = "SYSTEM_STAGE";
        throw err;
      }
      const usage = await client.query("SELECT COUNT(*)::int AS count FROM leads WHERE stage_id = $1", [id]);
      if (usage.rows[0].count > 0) {
        const err = new Error("Move leads out of this stage before changing its type.");
        err.code = "STAGE_IN_USE";
        throw err;
      }
    }

    const name = patch.name ?? current.name;
    const duplicate = await client.query(
      "SELECT 1 FROM pipeline_stages WHERE lower(name) = lower($1) AND id <> $2",
      [name, id]
    );
    if (duplicate.rows[0]) {
      const err = new Error("A stage with that name already exists.");
      err.code = "DUPLICATE_STAGE";
      throw err;
    }

    const result = await client.query(
      `UPDATE pipeline_stages
       SET name = $1, color = $2, stage_type = $3
       WHERE id = $4
       RETURNING id, name, sort_order, color, stage_type, system_key`,
      [name, patch.color ?? current.color, patch.stageType ?? current.stage_type, id]
    );
    return result.rows[0] || null;
  });
  if (updated) publishPipelineChange();
  return updated;
}

async function reorderStages(stageIds) {
  await withTransaction(async (client) => {
    const current = await client.query("SELECT id FROM pipeline_stages ORDER BY id");
    const currentIds = current.rows.map((row) => Number(row.id)).sort((a, b) => a - b);
    const requestedIds = stageIds.map(Number).sort((a, b) => a - b);
    if (currentIds.length !== requestedIds.length || currentIds.some((id, i) => id !== requestedIds[i])) {
      const err = new Error("Stage order must include every pipeline stage exactly once.");
      err.code = "INVALID_STAGE_ORDER";
      throw err;
    }
    for (let index = 0; index < stageIds.length; index += 1) {
      await client.query("UPDATE pipeline_stages SET sort_order = $1 WHERE id = $2", [
        (index + 1) * 10,
        stageIds[index],
      ]);
    }
  });
  publishPipelineChange();
  return listStages();
}

async function deleteStage(id) {
  const deleted = await withTransaction(async (client) => {
    const stage = await getStageById(id, client);
    if (!stage) return null;
    if (stage.system_key) {
      const err = new Error("Built-in stages can be renamed and reordered, but cannot be deleted.");
      err.code = "SYSTEM_STAGE";
      throw err;
    }
    const usage = await client.query("SELECT COUNT(*)::int AS count FROM leads WHERE stage_id = $1", [id]);
    if (usage.rows[0].count > 0) {
      const err = new Error("Move leads out of this stage before deleting it.");
      err.code = "STAGE_IN_USE";
      throw err;
    }
    if (stage.stage_type === "open") {
      const openCount = await client.query("SELECT COUNT(*)::int AS count FROM pipeline_stages WHERE stage_type = 'open'");
      if (openCount.rows[0].count <= 1) {
        const err = new Error("The pipeline needs at least one open stage.");
        err.code = "LAST_OPEN_STAGE";
        throw err;
      }
    }
    await client.query("DELETE FROM pipeline_stages WHERE id = $1", [id]);
    return stage;
  });
  if (deleted) publishPipelineChange();
  return deleted;
}

module.exports = {
  NO_REPLY_HOURS,
  listStages,
  listLeads,
  getLeadById,
  getActiveLeadForContact,
  ensureLeadForContact,
  markContactedForContact,
  backfillLeadsForExistingContacts,
  createLead,
  updateLead,
  applyAutomaticTemperature,
  listActivities,
  addNote,
  createStage,
  updateStage,
  reorderStages,
  deleteStage,
};
