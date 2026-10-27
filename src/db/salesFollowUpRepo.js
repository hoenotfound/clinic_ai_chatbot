const { pool } = require("./db");
const clinicConfig = require("../config/clinicConfig");
const realtimeEvents = require("../utils/realtimeEvents");
const { pendingSalesFollowUp, assertFollowUpOutcome } = require("../utils/salesFollowUpEligibility");

function extendedFollowUpHoldHours(env = process.env) {
  const cfg = clinicConfig.automatedFollowUp;
  if (cfg?.enabled !== true || cfg?.freeEntry?.enabled !== true ||
      String(env.WHATSAPP_FEP_FOLLOWUPS_ENABLED || "").toLowerCase() !== "true" ||
      !cfg.freeEntry.activatedAt || !Number.isFinite(Date.parse(cfg.freeEntry.activatedAt))) return 0;
  const slots = Array.isArray(cfg.freeEntry.slotsHours) ? cfg.freeEntry.slotsHours : [];
  const sevenDay = String(env.WHATSAPP_FEP_7DAY_VERIFIED || "").toLowerCase() === "true";
  const ceiling = sevenDay ? 168 : 72;
  const activeSlots = slots.filter(h => Number.isInteger(h) && h >= 25 && h < ceiling);
  return activeSlots.length ? Math.min(ceiling, Math.max(...activeSlots) + 12) : 0;
}

async function listPending({ username, canViewAll = false, leadId = null, queryable = pool, now = new Date() }) {
  const result = await queryable.query(
    `SELECT l.id AS lead_id, l.contact_id, l.owner_username, l.temperature,
            l.treatment_interest, l.appointment_status, l.is_closed, l.next_follow_up_at,
            s.name AS stage_name, s.stage_type, s.system_key,
            c.channel, c.whatsapp_number, c.mode, c.whatsapp_opt_in_at, c.whatsapp_opt_in_source,
            c.whatsapp_opt_out_at, c.whatsapp_marketing_opt_out_at,
            COALESCE(NULLIF(BTRIM(c.name),''), NULLIF(BTRIM(c.whatsapp_profile_name),''), c.whatsapp_number) AS customer_name,
            last_inbound.id AS last_inbound_id, last_inbound.created_at AS last_inbound_at,
            COALESCE(score.summary_data->>'treatmentInterest','') AS summary_treatment,
            COALESCE(score.summary_data->>'chatSummary','') AS chat_summary,
            COALESCE(score.summary_data->>'nextAction','') AS next_action,
            t.status AS task_status, t.due_at AS task_due_at, t.last_inbound_id AS task_last_inbound_id,
            (l.updated_at > t.updated_at) AS booking_reopened_after_task,
            (score.through_message_id >= last_inbound.id AND score.updated_at > t.updated_at
             AND NULLIF(BTRIM(COALESCE(score.summary_data->>'treatmentInterest','')),'') IS NOT NULL) AS new_verified_interest,
            EXISTS (
              SELECT 1 FROM messages staff
              WHERE staff.contact_id = c.id AND staff.role='assistant'
                AND staff.sent_by_username IS NOT NULL
                AND (staff.created_at, staff.id) > (last_inbound.created_at, last_inbound.id)
                AND staff.created_at > COALESCE(t.updated_at, last_inbound.created_at)
            ) AS staff_replied_after_inbound,
            ($3::integer > 0 AND EXISTS (
              -- Inspect verified free-entry eligibility BEFORE the next scheduled
              -- attempt is claimed. Attempt-only checks miss all future sends.
              SELECT 1 FROM whatsapp_free_entry_referrals ref
              JOIN messages origin ON origin.id=ref.origin_message_id
                AND origin.contact_id=c.id AND origin.role='user'
              JOIN LATERAL (
                SELECT m.id,m.created_at,m.whatsapp_message_id
                FROM messages m
                WHERE m.contact_id=c.id AND m.role='assistant'
                  AND m.whatsapp_message_id IS NOT NULL
                  AND m.created_at >= origin.created_at
                  AND m.created_at < origin.created_at + interval '24 hours'
                ORDER BY m.created_at,m.id LIMIT 1
              ) first_reply ON true
              JOIN whatsapp_free_entry_pricing_evidence proof
                ON proof.wamid=first_reply.whatsapp_message_id
                AND proof.pricing_type='free_entry_point'
                AND proof.billable=false
                AND proof.delivery_status IN ('sent','delivered','read')
              WHERE ref.contact_id=c.id
                AND (ref.ctwa_clid IS NOT NULL OR ref.meta_ad_id IS NOT NULL)
                AND first_reply.created_at >= $6::timestamptz - interval '24 hours'
                AND first_reply.created_at + ($3::integer * interval '1 hour') > $5::timestamptz
                AND first_reply.created_at <= $5::timestamptz
            )) AS active_extended_follow_up
     FROM leads l
     JOIN pipeline_stages s ON s.id = l.stage_id
     JOIN contacts c ON c.id = l.contact_id
     JOIN LATERAL (
       SELECT m.id, m.created_at
       FROM messages m
       WHERE m.contact_id = c.id AND m.role = 'user'
         AND (
           (l.started_message_id IS NOT NULL AND m.id >= l.started_message_id)
           OR (l.started_message_id IS NULL AND m.created_at >= l.created_at)
         )
       ORDER BY m.created_at DESC, m.id DESC LIMIT 1
     ) last_inbound ON true
     LEFT JOIN LATERAL (
       SELECT summary_data, through_message_id
       FROM lead_temperature_scores sc
       WHERE sc.lead_id = l.id AND sc.status = 'completed'
         AND sc.through_message_id >= last_inbound.id
       ORDER BY sc.through_message_id DESC, sc.id DESC LIMIT 1
     ) score ON true
     LEFT JOIN sales_follow_up_tasks t ON t.lead_id = l.id
     WHERE l.is_closed = false AND s.stage_type = 'open'
       AND l.temperature IN ('hot','warm')
       AND c.channel = 'whatsapp'
       AND last_inbound.created_at <= $5::timestamptz - interval '48 hours'
       AND ($1::boolean OR l.owner_username = $2::text)
       AND ($4::integer IS NULL OR l.id = $4)
     ORDER BY last_inbound.created_at DESC, l.id DESC
     LIMIT $7::integer OFFSET $8::integer`,
    [canViewAll, username, extendedFollowUpHoldHours(), leadId, now,
      clinicConfig.automatedFollowUp?.freeEntry?.activatedAt || null, 500, 0]
  );
  return result.rows.filter((row) => pendingSalesFollowUp(row, now)).map((row) => ({
    leadId: row.lead_id,
    contactId: row.contact_id,
    customerName: row.customer_name,
    whatsappNumber: row.whatsapp_number,
    treatment: row.treatment_interest || row.summary_treatment,
    temperature: row.temperature,
    stageName: row.stage_name,
    owner: row.owner_username || "Unassigned",
    lastCustomerReplyAt: row.last_inbound_at,
    summary: String(row.chat_summary || "").slice(0, 300),
    nextAction: String(row.next_action || "").slice(0, 150),
    whatsappUrl: "https://wa.me/" + row.whatsapp_number,
    lastInboundId: row.last_inbound_id
  }));
}

async function recordOutcome({ leadId, status, dueAt, username, canManageAll = false, now = new Date() }) {
  const id = Number(leadId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    const error = new Error("Invalid lead."); error.status = 400; throw error;
  }
  const validatedDate = assertFollowUpOutcome(status, dueAt, now);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT id, owner_username FROM leads WHERE id=$1 FOR UPDATE", [id]);
    if (!locked.rows.length || (!canManageAll && locked.rows[0].owner_username !== username)) {
      const error = new Error("Lead not found or not assigned to you."); error.status = 404; throw error;
    }
    const eligible = await listPending({ username, canViewAll: canManageAll, leadId: id, queryable: client, now });
    if (eligible.length !== 1) {
      const error = new Error("This lead is no longer pending. Refresh before updating."); error.status = 409; throw error;
    }
    const inboundId = eligible[0].lastInboundId;
    await client.query(
      `INSERT INTO sales_follow_up_tasks (lead_id,status,last_inbound_id,due_at,updated_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (lead_id) DO UPDATE
         SET status=EXCLUDED.status, last_inbound_id=EXCLUDED.last_inbound_id,
             due_at=EXCLUDED.due_at, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [id,status,inboundId,validatedDate,username]
    );
    await client.query(
      "INSERT INTO sales_follow_up_events (lead_id,actor,outcome,inbound_id,due_at) VALUES ($1,$2,$3,$4,$5)",
      [id,username,status,inboundId,validatedDate]
    );
    if (status === "booked") {
      const previous = await client.query(
        "SELECT l.stage_id, l.appointment_status, s.system_key, s.name AS stage_name FROM leads l JOIN pipeline_stages s ON s.id=l.stage_id WHERE l.id=$1",
        [id]
      );
      const current = previous.rows[0];
      let next = null;
      // Match the existing Pipeline booking behavior: only auto-move default
      // New/Contacted stages, never a customized or previously visited stage.
      if (["new", "contacted"].includes(current.system_key)) {
        const appointmentStage = await client.query(
          "SELECT id, name FROM pipeline_stages WHERE system_key='appointment_set' AND stage_type='open' LIMIT 1"
        );
        next = appointmentStage.rows[0] || null;
      }
      await client.query(
        "UPDATE leads SET appointment_status='set', appointment_at=$2, stage_id=COALESCE($3::integer,stage_id), updated_at=now() WHERE id=$1 AND is_closed=false",
        [id, validatedDate, next?.id || null]
      );
      if (next && Number(next.id) !== Number(current.stage_id)) {
        await client.query(
          "INSERT INTO lead_stage_history (lead_id,from_stage_id,to_stage_id,changed_by) VALUES ($1,$2,$3,$4)",
          [id,current.stage_id,next.id,username]
        );
        await client.query(
          "INSERT INTO lead_activities (lead_id,activity_type,description,actor,metadata) VALUES ($1,'stage',$2,$3,$4::jsonb)",
          [id,"Moved from " + current.stage_name + " to " + next.name + ".",username,
            JSON.stringify({fromStageId:current.stage_id,toStageId:next.id})]
        );
      }
      await client.query(
        "INSERT INTO lead_activities (lead_id,activity_type,description,actor,metadata) VALUES ($1,'updated',$2,$3,$4::jsonb)",
        [id,"Appointment confirmed from Sales Follow-up.",username,
          JSON.stringify({appointmentStatus:"set",previousAppointmentStatus:current.appointment_status})]
      );
    }
    await client.query("COMMIT");
    if (status === "booked") {
      // The existing Pipeline clears Booking Ready attention after commit,
      // never while the lead row lock is held (contact/lead lock order).
      try {
        const cleared = await pool.query(
          "UPDATE contacts c SET needs_attention=false, attention_reason=NULL, updated_at=now() WHERE c.id=$1 AND c.needs_attention=true AND c.attention_reason LIKE 'Booking ready:%' RETURNING c.id",
          [eligible[0].contactId]
        );
        if (cleared.rows[0]) realtimeEvents.publish("conversation_changed", {
          contactId: eligible[0].contactId, reason: "booking_confirmed"
        });
      } catch (cleanupError) {
        console.error("Sales follow-up booking attention cleanup failed:", cleanupError);
      }
    }
    realtimeEvents.publish("pipeline_changed", { leadId: id });
    return { ok: true, leadId: id, status };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { extendedFollowUpHoldHours, listPending, recordOutcome };
