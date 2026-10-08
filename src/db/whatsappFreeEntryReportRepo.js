const { pool } = require("./db");

// Read-only rollout diagnostics. Ads do not automatically imply marketing opt-in.
async function summarize(database = pool) {
  const leads = await database.query(
    `WITH current_leads AS (
       SELECT DISTINCT ON (l.contact_id) l.id, l.contact_id, l.marketing_consent,
         l.is_closed, l.appointment_status, la.ctwa_clid,
         la.first_message_id, c.whatsapp_opt_in_at,
         c.whatsapp_opt_in_source, c.whatsapp_opt_out_at,
         c.whatsapp_marketing_opt_out_at
       FROM leads l
       JOIN contacts c ON c.id = l.contact_id
       JOIN lead_attributions la ON la.lead_id = l.id
       WHERE c.channel = 'whatsapp'
         AND la.channel = 'whatsapp'
         AND la.meta_source_type = 'ad'
       ORDER BY l.contact_id, l.is_closed ASC, l.created_at DESC, l.id DESC
     ), sampled AS (
       SELECT l.*,
         first_reply.id AS response_id, billing.pricing_type,
         billing.billable
       FROM current_leads l
       LEFT JOIN LATERAL (
         SELECT m.id, m.whatsapp_message_id
         FROM messages m
         JOIN messages origin ON origin.id = l.first_message_id
         WHERE m.contact_id = l.contact_id AND m.role = 'assistant'
           AND m.whatsapp_message_id IS NOT NULL
           AND m.created_at >= origin.created_at
           AND m.created_at < origin.created_at + interval '24 hours'
         ORDER BY m.created_at, m.id LIMIT 1
       ) first_reply ON true
       LEFT JOIN whatsapp_free_entry_pricing_evidence billing
         ON billing.wamid = first_reply.whatsapp_message_id
     )
     SELECT COUNT(*)::int AS ad_leads,
       COUNT(*) FILTER (WHERE ctwa_clid IS NOT NULL)::int AS ctwa_click_ids,
       COUNT(*) FILTER (WHERE marketing_consent = 'opted_in'
         AND whatsapp_opt_in_at IS NOT NULL AND whatsapp_opt_in_source IS NOT NULL
         AND whatsapp_opt_out_at IS NULL
         AND whatsapp_marketing_opt_out_at IS NULL)::int AS explicit_marketing_optins,
       COUNT(*) FILTER (WHERE response_id IS NOT NULL)::int AS first_replies,
       COUNT(*) FILTER (WHERE pricing_type = 'free_entry_point'
         AND billable = false)::int AS verified_free_entry,
       COUNT(*) FILTER (WHERE billable = true)::int AS confirmed_billable
     FROM sampled`
  );
  const attempts = await database.query(
    `SELECT status, COUNT(*)::int AS count
     FROM whatsapp_free_entry_followup_attempts
     GROUP BY status ORDER BY status`
  );
  const recent = await database.query(
    `SELECT contact_id, slot_hours, status, created_at,
            CASE WHEN error IS NULL THEN NULL ELSE left(error, 160) END AS error,
            EXISTS (
              SELECT 1 FROM whatsapp_free_entry_pricing_evidence p
              WHERE p.wamid = attempts.wamid AND p.billable = true
            ) AS billable
     FROM whatsapp_free_entry_followup_attempts attempts
     ORDER BY created_at DESC, id DESC LIMIT 25`
  );
  const contactDetails = await database.query(`
    WITH selected AS (
      SELECT DISTINCT ON (l.contact_id)
        l.id AS lead_id, l.contact_id, l.marketing_consent,
        l.is_closed, l.appointment_status, l.treatment_interest,
        l.created_at, c.mode, c.needs_attention,
        c.whatsapp_opt_in_at, c.whatsapp_opt_in_source,
        c.whatsapp_opt_out_at, c.whatsapp_marketing_opt_out_at,
        la.first_message_id
      FROM leads l
      JOIN contacts c ON c.id=l.contact_id
      JOIN lead_attributions la ON la.lead_id=l.id
      WHERE c.channel='whatsapp' AND la.channel='whatsapp'
        AND LOWER(COALESCE(la.meta_source_type,''))='ad'
      ORDER BY l.contact_id,l.is_closed ASC,l.created_at DESC,l.id DESC
    )
    SELECT selected.contact_id,selected.lead_id,selected.treatment_interest,
      first_reply.created_at AS first_reply_at,
      first_reply.created_at + interval '7 days' AS free_entry_max_expires_at,
      billing.pricing_type,billing.billable,
      last_skip.reason AS last_skip_reason,
      last_attempt.status AS last_attempt_status,
      CASE
        WHEN selected.whatsapp_opt_out_at IS NOT NULL OR
             selected.whatsapp_marketing_opt_out_at IS NOT NULL THEN 'opted_out'
        WHEN selected.marketing_consent <> 'opted_in' THEN 'marketing_consent_missing'
        WHEN selected.whatsapp_opt_in_at IS NULL OR selected.whatsapp_opt_in_source IS NULL
          THEN 'whatsapp_opt_in_missing'
        WHEN selected.mode='human' THEN 'human_takeover'
        WHEN selected.needs_attention THEN 'staff_attention'
        WHEN selected.is_closed OR selected.appointment_status IN ('set','visited') THEN 'booked_or_closed'
        WHEN first_reply.id IS NULL THEN 'first_response_not_confirmed'
        WHEN billing.billable = true THEN 'charged_by_meta'
        WHEN billing.pricing_type IS DISTINCT FROM 'free_entry_point' OR
             billing.billable IS DISTINCT FROM false THEN 'free_entry_billing_unconfirmed'
        WHEN first_reply.created_at + interval '7 days' <= now() THEN 'expired'
        WHEN last_attempt.status IN ('unknown','failed','sending') THEN 'previous_send_unconfirmed'
        ELSE 'potentially_eligible'
      END AS eligibility_reason
    FROM selected
    LEFT JOIN LATERAL(
      SELECT m.id,m.created_at,m.whatsapp_message_id FROM messages m
      JOIN messages original ON original.id=selected.first_message_id
      WHERE m.contact_id=selected.contact_id AND m.role='assistant'
        AND m.whatsapp_message_id IS NOT NULL
        AND m.created_at>=original.created_at
        AND m.created_at<original.created_at+interval '24 hours'
      ORDER BY m.created_at,m.id LIMIT 1
    ) first_reply ON true
    LEFT JOIN whatsapp_free_entry_pricing_evidence billing
      ON billing.wamid=first_reply.whatsapp_message_id
    LEFT JOIN LATERAL(
      SELECT reason FROM whatsapp_free_entry_followup_skips s
      WHERE s.contact_id=selected.contact_id
      ORDER BY observed_at DESC LIMIT 1
    ) last_skip ON true
    LEFT JOIN LATERAL(
      SELECT status FROM whatsapp_free_entry_followup_attempts a
      WHERE a.contact_id=selected.contact_id
      ORDER BY created_at DESC,id DESC LIMIT 1
    ) last_attempt ON true
    ORDER BY selected.created_at DESC LIMIT 40
  `);
  return {
    leads: leads.rows[0] || {},
    attempts: attempts.rows,
    recentAttempts: recent.rows,
    contactDetails: contactDetails.rows,
  };
}

async function recordSkip(contactId, firstReplyId, slotHours, reason) {
  await pool.query(
    `INSERT INTO whatsapp_free_entry_followup_skips
      (contact_id,first_reply_message_id,slot_hours,reason)
     VALUES($1,$2,$3,$4) ON CONFLICT (first_reply_message_id,slot_hours,reason)
     DO UPDATE SET observed_at=now()`,
    [contactId,firstReplyId,slotHours,String(reason).slice(0,100)]
  );
}

module.exports = { summarize, recordSkip };
