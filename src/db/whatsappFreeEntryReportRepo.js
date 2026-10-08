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
  return {
    leads: leads.rows[0] || {},
    attempts: attempts.rows,
    recentAttempts: recent.rows,
  };
}

module.exports = { summarize };
