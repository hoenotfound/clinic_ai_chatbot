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
  const sql = `SELECT l.id AS lead_id, l.contact_id, l.owner_username, l.temperature,
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
                AND l.marketing_consent = 'opted_in'
                AND c.needs_attention = false
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
       SELECT summary_data, through_message_id, updated_at
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
     LIMIT $7::integer OFFSET $8::integer`;
  // Fetch bounded candidate batches instead of losing the whole export at 3,001.
  const candidates = [];
  const PAGE_SIZE = 500;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    // A defensive ceiling prevents a misconfigured report from exhausting Neon
    // compute indefinitely; an error never silently produces a partial export.
    if (offset >= 100000) {
      const err = new Error("This report is unusually large. Contact an administrator to narrow it.");
      err.status = 409; throw err;
    }
    const result = await queryable.query(sql, [
      canViewAll, username, extendedFollowUpHoldHours(), leadId, now,
      clinicConfig.automatedFollowUp?.freeEntry?.activatedAt || null, PAGE_SIZE, offset
    ]);
    candidates.push(...result.rows);
    if (result.rows.length < PAGE_SIZE) break;
  }
  return candidates.filter((row) => pendingSalesFollowUp(row, now)).map((row) => ({
    leadId: row.lead_id,
    contactId: row.contact_id,
    customerName: row.customer_name,
    whatsappNumber: row.whatsapp_number,
    treatment: row.treatment_interest || row.summary_treatment,
    temperature: row.temperature,
    stageName: row.stage_name,
    reason: row.task_status === "later" || (row.task_status === "contacted" && row.task_due_at)
      ? "follow_up_due" : row.task_status === "not_interested" ? "interested_again" :
      row.task_status === "booked" ? "booking_cancelled" : "new",
    taskDueAt: row.task_due_at,
    owner: row.owner_username || "Unassigned",
    lastCustomerReplyAt: row.last_inbound_at,
    summary: String(row.chat_summary || "").slice(0, 300),
    nextAction: String(row.next_action || "").slice(0, 150),
    whatsappUrl: "https://wa.me/" + row.whatsapp_number,
    lastInboundId: row.last_inbound_id
  }));
}

async function recordOutcome({ leadId, status, dueAt, expectedLastInboundId, username, canManageAll = false, now = new Date() }) {
  const id = Number(leadId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    const error = new Error("Invalid lead."); error.status = 400; throw error;
  }
  const inboundExpected = Number(expectedLastInboundId);
  if (!Number.isSafeInteger(inboundExpected) || inboundExpected < 1) {
    const error = new Error("Refresh the lead before saving the follow-up result.");
    error.status = 400; throw error;
  }
  const validatedDate = assertFollowUpOutcome(status, dueAt, now);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Contacts are locked before leads to preserve inbound/booking lock order.
    // Re-read lead ID after the contact lock so reassignment is checked fresh.
    const target = await client.query("SELECT contact_id FROM leads WHERE id=$1", [id]);
    if (!target.rows.length) {
      const error = new Error("Lead not found."); error.status = 404; throw error;
    }
    await client.query("SELECT id FROM contacts WHERE id=$1 FOR UPDATE", [target.rows[0].contact_id]);
    const locked = await client.query("SELECT id, owner_username, contact_id FROM leads WHERE id=$1 FOR UPDATE", [id]);
    if (!locked.rows.length || (!canManageAll && locked.rows[0].owner_username !== username)) {
      const error = new Error("Lead not found or not assigned to you."); error.status = 404; throw error;
    }
    const eligible = await listPending({ username, canViewAll: canManageAll, leadId: id, queryable: client, now });
    if (eligible.length !== 1 || Number(eligible[0].lastInboundId) !== inboundExpected) {
      const error = new Error("The conversation or lead status has changed. Refresh before updating."); error.status = 409; throw error;
    }
    const inboundId = eligible[0].lastInboundId;
    const previousTask = (await client.query(
      "SELECT status,last_inbound_id,due_at,updated_by FROM sales_follow_up_tasks WHERE lead_id=$1",
      [id]
    )).rows[0] || null;
    const previousLead = (await client.query(
      "SELECT stage_id,appointment_status,appointment_at,updated_at FROM leads WHERE id=$1",
      [id]
    )).rows[0];
    await client.query(
      `INSERT INTO sales_follow_up_tasks (lead_id,status,last_inbound_id,due_at,updated_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (lead_id) DO UPDATE
         SET status=EXCLUDED.status, last_inbound_id=EXCLUDED.last_inbound_id,
             due_at=EXCLUDED.due_at, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [id,status,inboundId,validatedDate,username]
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
    const appliedLead = (await client.query(
      "SELECT stage_id,appointment_status,appointment_at,updated_at FROM leads WHERE id=$1",
      [id]
    )).rows[0];
    const appliedTask = (await client.query(
      "SELECT updated_at FROM sales_follow_up_tasks WHERE lead_id=$1", [id]
    )).rows[0];
    const event = await client.query(
      `INSERT INTO sales_follow_up_events
        (lead_id,actor,outcome,inbound_id,due_at,previous_state)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
      [id,username,status,inboundId,validatedDate,JSON.stringify({
        previousTask, previousLead, appliedLead, appliedTaskUpdatedAt: appliedTask.updated_at
      })]
    );
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
    return { ok: true, leadId: id, status, eventId: Number(event.rows[0].id) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}


const UNDO_MINUTES = 10;
function invalidCorrection(message, status = 409) {
  const error = new Error(message); error.status = status; throw error;
}

async function listRecentCorrections({ username, canViewAll = false, now = new Date(), queryable = pool }) {
  const r = await queryable.query(
    `SELECT e.id AS "eventId", e.lead_id AS "leadId", e.outcome,
      e.inbound_id AS "lastInboundId", e.created_at AS "createdAt",
      COALESCE(NULLIF(BTRIM(c.name), ''), NULLIF(BTRIM(c.whatsapp_profile_name), ''),
        c.whatsapp_number) AS "customerName"
      FROM sales_follow_up_events e
      JOIN leads l ON l.id=e.lead_id
      JOIN contacts c ON c.id=l.contact_id
      WHERE e.undone_at IS NULL AND e.previous_state IS NOT NULL
        AND e.created_at >= $3::timestamptz - interval '10 minutes'
        AND (e.actor=$2::text OR $1::boolean)
        AND ($1::boolean OR l.owner_username=$2::text)
        AND NOT EXISTS (
          SELECT 1 FROM sales_follow_up_events newer
          WHERE newer.lead_id=e.lead_id AND newer.id > e.id
        )
      ORDER BY e.created_at DESC, e.id DESC LIMIT 20`,
    [canViewAll, username, now]
  );
  return r.rows;
}

// Only undo the latest outcome, for up to ten minutes, while the lead and
// message context are unchanged. This cannot recall a WhatsApp message.
async function undoOutcome({ leadId, eventId, username, canManageAll = false, now = new Date() }) {
  const id=Number(leadId), eid=Number(eventId);
  if (![id,eid].every(x=>Number.isSafeInteger(x)&&x>0)) invalidCorrection("Invalid correction request.",400);
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const target=await client.query("SELECT contact_id FROM leads WHERE id=$1", [id]);
    if (!target.rows.length) invalidCorrection("Lead not found.",404);
    await client.query("SELECT id FROM contacts WHERE id=$1 FOR UPDATE", [target.rows[0].contact_id]);
    const row=await client.query(
      "SELECT id,contact_id,owner_username,stage_id,appointment_status,appointment_at,updated_at FROM leads WHERE id=$1 FOR UPDATE",
      [id]
    );
    const lead=row.rows[0];
    if (!lead || (!canManageAll && lead.owner_username!==username)) invalidCorrection("Not assigned to you.",403);
    const event=(await client.query(
      "SELECT * FROM sales_follow_up_events WHERE id=$1 AND lead_id=$2 FOR UPDATE",
      [eid,id]
    )).rows[0];
    if (!event || event.undone_at || !event.previous_state ||
        (!canManageAll && event.actor!==username)) invalidCorrection("This result cannot be corrected.",403);
    if (now.getTime()-new Date(event.created_at).getTime()>UNDO_MINUTES*60000 ||
        now.getTime()<new Date(event.created_at).getTime()) {
      invalidCorrection("Correction time expired. Ask a manager to review the Pipeline.");
    }
    const latestEvent=await client.query(
      "SELECT id FROM sales_follow_up_events WHERE lead_id=$1 ORDER BY id DESC LIMIT 1", [id]
    );
    if (Number(latestEvent.rows[0]?.id)!==eid) invalidCorrection("A newer result already exists.");
    const inbound=(await client.query(
      "SELECT id FROM messages WHERE contact_id=$1 AND role='user' ORDER BY created_at DESC,id DESC LIMIT 1",
      [lead.contact_id]
    )).rows[0];
    if (Number(inbound?.id)!==Number(event.inbound_id)) {
      invalidCorrection("Customer replied since this result. Refresh the Pipeline first.");
    }
    const applied=event.previous_state.appliedLead;
    const task=(await client.query(
      "SELECT status,last_inbound_id,due_at,updated_at FROM sales_follow_up_tasks WHERE lead_id=$1 FOR UPDATE", [id]
    )).rows[0];
    if (!applied || !task || task.status!==event.outcome ||
        Number(task.last_inbound_id)!==Number(event.inbound_id) ||
        new Date(task.updated_at).getTime()!==new Date(event.previous_state.appliedTaskUpdatedAt).getTime() ||
        Number(lead.stage_id)!==Number(applied.stage_id) ||
        lead.appointment_status!==applied.appointment_status ||
        String(lead.appointment_at ? new Date(lead.appointment_at).toISOString() : "")!==
          String(applied.appointment_at ? new Date(applied.appointment_at).toISOString() : "") ||
        new Date(lead.updated_at).getTime()!==new Date(applied.updated_at).getTime()) {
      invalidCorrection("The lead changed after this update. Review it in Pipeline rather than undoing.");
    }
    const previous=event.previous_state;
    if (event.outcome==="booked") {
      await client.query(
        "UPDATE leads SET stage_id=$2,appointment_status=$3,appointment_at=$4,updated_at=now() WHERE id=$1",
        [id,previous.previousLead.stage_id,previous.previousLead.appointment_status,
          previous.previousLead.appointment_at]
      );
      if (Number(lead.stage_id)!==Number(previous.previousLead.stage_id)) {
        await client.query(
          "INSERT INTO lead_stage_history (lead_id,from_stage_id,to_stage_id,changed_by) VALUES ($1,$2,$3,$4)",
          [id,lead.stage_id,previous.previousLead.stage_id,username]
        );
      }
      await client.query(
        "INSERT INTO lead_activities (lead_id,activity_type,description,actor,metadata) VALUES ($1,'updated',$2,$3,$4::jsonb)",
        [id,"Corrected mistaken Sales Follow-up booking.",username,JSON.stringify({undoneEventId:eid})]
      );
    }
    if (previous.previousTask) {
      await client.query(
        `UPDATE sales_follow_up_tasks
         SET status=$2,last_inbound_id=$3,due_at=$4,updated_by=$5,updated_at=now()
         WHERE lead_id=$1`,
        [id,previous.previousTask.status,previous.previousTask.last_inbound_id,
          previous.previousTask.due_at,previous.previousTask.updated_by]
      );
    } else {
      await client.query("DELETE FROM sales_follow_up_tasks WHERE lead_id=$1", [id]);
    }
    await client.query(
      "UPDATE sales_follow_up_events SET undone_at=now(),undone_by=$2 WHERE id=$1",
      [eid,username]
    );
    await client.query("COMMIT");
    realtimeEvents.publish("pipeline_changed",{leadId:id});
    return { ok:true, leadId:id, undoneEventId:eid };
  } catch (error) {
    await client.query("ROLLBACK").catch(()=>{});
    throw error;
  } finally { client.release(); }
}

async function countMonthlyOutcomes({ username, canViewAll = false, queryable = pool, now = new Date() }) {
  // Month boundaries are Malaysia-local, not UTC, so the monthly figures
  // match the period understood by Neutro's sales manager.
  const result = await queryable.query(
    `SELECT e.outcome, COUNT(DISTINCT e.lead_id)::integer AS leads
     FROM sales_follow_up_events e
     JOIN leads l ON l.id = e.lead_id
     WHERE e.undone_at IS NULL AND e.created_at >= (
       date_trunc('month', $3::timestamptz AT TIME ZONE 'Asia/Kuala_Lumpur')
       AT TIME ZONE 'Asia/Kuala_Lumpur'
     ) AND e.created_at <= $3::timestamptz
       AND ($1::boolean OR l.owner_username = $2::text)
     GROUP BY e.outcome`,
    [canViewAll, username, now]
  );
  return Object.fromEntries(
    ["contacted", "later", "booked", "not_interested", "unable"]
      .map(outcome => [outcome, Number(result.rows.find(row => row.outcome === outcome)?.leads || 0)])
  );
}

module.exports = { extendedFollowUpHoldHours, listPending, recordOutcome, countMonthlyOutcomes, listRecentCorrections, undoOutcome };
