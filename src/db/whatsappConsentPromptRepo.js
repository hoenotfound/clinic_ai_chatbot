"use strict";

const { pool } = require("./db");
const { CONVERSATION_LOCK_NAMESPACE } = require("./conversationLock");
const { followUpAttentionAllowedSql } = require("../utils/aiReviewPolicy");
const { CONSENT_SCOPE, CONSENT_CATEGORY } = require("../utils/whatsappConsentPrompt");

const DUE_AFTER_THIRD_MINUTES = 15;
const SAFETY_WINDOW_MINUTES = 10;

// This is an auxiliary one-shot request. It is not an additional sequence step.
// The same inbox conversation, lead and last customer message must remain active.
const CANDIDATES_SQL = `
SELECT
 c.id AS contact_id,c.whatsapp_number, lead.id AS lead_id,
 lead.treatment_interest AS service_name, inbound.id AS inbound_id,
 inbound.created_at AS inbound_at,
 anchor.id AS anchor_id, final.id AS third_id,
 final.whatsapp_accepted_at AS third_accepted_at,
 final.whatsapp_accepted_at + interval '${DUE_AFTER_THIRD_MINUTES} minutes' AS due_at
FROM contacts c
JOIN LATERAL (
 SELECT m.id,m.created_at,COALESCE(m.source_created_at,m.created_at) AS source_at
 FROM messages m WHERE m.contact_id=c.id AND m.role='user'
 ORDER BY m.created_at DESC,m.id DESC LIMIT 1
) inbound ON true
JOIN LATERAL (
 SELECT m.id,m.created_at,m.sent_by_username
 FROM messages m WHERE m.contact_id=c.id AND m.role='assistant'
  AND m.is_automated_follow_up=false
  AND m.delivery_status IS DISTINCT FROM 'failed'
  AND m.delivery_status IS DISTINCT FROM 'cancelled'
  AND (m.created_at,m.id)>(inbound.created_at,inbound.id)
  AND NOT EXISTS(SELECT 1 FROM outbound_message_evidence e
    WHERE e.message_id=m.id AND e.origin='system_fallback')
 ORDER BY m.created_at DESC,m.id DESC LIMIT 1
) anchor ON true
JOIN LATERAL (
 SELECT m.id,m.whatsapp_accepted_at
 FROM messages m WHERE m.contact_id=c.id AND m.role='assistant'
  AND m.is_automated_follow_up=true
  AND m.automated_follow_up_for_message_id=anchor.id
  AND m.automated_follow_up_step=3
  AND m.whatsapp_accepted_at IS NOT NULL AND m.whatsapp_message_id IS NOT NULL
  AND m.delivery_status IN ('pending','sent','delivered','read')
 ORDER BY m.created_at DESC,m.id DESC LIMIT 1
) final ON true
JOIN LATERAL (
 SELECT l.id,l.treatment_interest,l.marketing_consent,l.is_closed,
  l.appointment_status,s.stage_type,s.system_key
 FROM leads l LEFT JOIN pipeline_stages s ON s.id=l.stage_id
 WHERE l.contact_id=c.id ORDER BY l.is_closed ASC,l.created_at DESC,l.id DESC LIMIT 1
) lead ON true
WHERE c.channel='whatsapp' AND c.whatsapp_number IS NOT NULL
 AND COALESCE(c.mode,'ai') <> 'human'
 AND ${followUpAttentionAllowedSql("c")}
 AND c.whatsapp_opt_out_at IS NULL AND c.whatsapp_marketing_opt_out_at IS NULL
 AND lead.marketing_consent IS DISTINCT FROM 'opted_in'
 AND lead.is_closed=false AND COALESCE(lead.stage_type,'open')='open'
 AND COALESCE(lead.appointment_status,'none') NOT IN ('set','visited')
 AND COALESCE(lead.system_key,'') NOT IN ('appointment_set','visited')
 AND NULLIF(BTRIM(lead.treatment_interest),'') IS NOT NULL
 AND anchor.created_at >= $1::timestamptz
 AND ($2::text='all' OR anchor.sent_by_username IS NOT NULL)
 AND inbound.source_at <= $3::timestamptz
 AND $3::timestamptz < inbound.source_at + interval '23 hours 50 minutes'
 AND NOT EXISTS(SELECT 1 FROM whatsapp_consent_prompts p WHERE p.lead_id=lead.id)
 AND NOT EXISTS(SELECT 1 FROM follow_up_ai_decisions d
  WHERE d.contact_id=c.id AND d.trigger_message_id=anchor.id
   AND d.action IN ('skip','human_review'))
 AND NOT EXISTS(SELECT 1 FROM messages m
  WHERE m.contact_id=c.id AND m.pricing_reminder_anchor_id=anchor.id
    AND (m.delivery_status IS NULL OR m.delivery_status IN ('pending','unknown','failed')))
 AND final.whatsapp_accepted_at + interval '${DUE_AFTER_THIRD_MINUTES} minutes'
  < inbound.source_at + interval '23 hours 50 minutes'
ORDER BY due_at,contact_id
LIMIT 200
`;

async function listCandidates({ activatedAt, triggerMode, now = new Date() }, database = pool) {
  const result = await database.query(CANDIDATES_SQL,
    [activatedAt,triggerMode,new Date(now).toISOString()]);
  return result.rows;
}

async function claim(candidate, { activatedAt, triggerMode, now = new Date(), question }, database = pool) {
  // Use the normal conversation lock and a unique lead prompt. A second
  // process cannot schedule another prompt for the same active CRM lead.
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1,$2)",
      [CONVERSATION_LOCK_NAMESPACE,candidate.contact_id]);
    const fresh = (await client.query(CANDIDATES_SQL,
      [activatedAt,triggerMode,new Date(now).toISOString()])).rows
      .find(row => Number(row.contact_id)===Number(candidate.contact_id) &&
        Number(row.anchor_id)===Number(candidate.anchor_id) &&
        Number(row.inbound_id)===Number(candidate.inbound_id) &&
        Number(row.third_id)===Number(candidate.third_id) &&
        Number(row.lead_id)===Number(candidate.lead_id));
    if (!fresh || Date.parse(fresh.due_at)>new Date(now).getTime() ||
        String(fresh.service_name)!==String(candidate.service_name)) {
      await client.query("ROLLBACK");
      return null;
    }
    const prompt = await client.query(
      `INSERT INTO whatsapp_consent_prompts(contact_id,lead_id,anchor_id,service_name,question)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
      [fresh.contact_id,fresh.lead_id,fresh.anchor_id,fresh.service_name,question]
    );
    if (!prompt.rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }
    // Unanchored automated message: never increments ordinary FU progress.
    const message = await client.query(
      `INSERT INTO messages(contact_id,role,content,sent_by_username,is_automated_follow_up,
       automated_follow_up_message_mode)
       VALUES($1,'assistant',$2,'Consent request automation',true,'fixed') RETURNING id,contact_id,content`,
      [fresh.contact_id,question]
    );
    await client.query(
      "UPDATE whatsapp_consent_prompts SET message_id=$2 WHERE id=$1",
      [prompt.rows[0].id,message.rows[0].id]);
    await client.query("COMMIT");
    return { ...fresh, promptId:prompt.rows[0].id, message:message.rows[0], question };
  } catch(error) {
    await client.query("ROLLBACK").catch(()=>{});
    throw error;
  } finally {client.release();}
}

async function stillEligible(claimed, { activatedAt, triggerMode }, database = pool) {
  const result = await database.query(
    `SELECT EXISTS (
      SELECT 1 FROM whatsapp_consent_prompts p
      JOIN messages m ON m.id=p.message_id AND m.contact_id=p.contact_id
      JOIN contacts c ON c.id=p.contact_id
      JOIN leads l ON l.id=p.lead_id AND l.contact_id=p.contact_id
      LEFT JOIN pipeline_stages stage ON stage.id=l.stage_id
      JOIN messages anchor ON anchor.id=p.anchor_id AND anchor.contact_id=p.contact_id
      JOIN messages latest ON latest.id=$4 AND latest.contact_id=p.contact_id AND latest.role='user'
      WHERE p.id=$1 AND p.contact_id=$2 AND p.anchor_id=$3
        AND p.status='claimed' AND p.decision IS NULL
        AND m.delivery_status IS NULL AND m.whatsapp_message_id IS NULL
        AND c.channel='whatsapp' AND c.whatsapp_number=$5
        AND COALESCE(c.mode,'ai') <> 'human'
        AND ${followUpAttentionAllowedSql("c")}
        AND c.whatsapp_opt_out_at IS NULL AND c.whatsapp_marketing_opt_out_at IS NULL
        AND l.is_closed=false AND l.marketing_consent IS DISTINCT FROM 'opted_in'
        AND COALESCE(l.appointment_status,'none') NOT IN ('set','visited')
        AND COALESCE(stage.stage_type,'open')='open'
        AND COALESCE(stage.system_key,'') NOT IN ('appointment_set','visited')
        AND NULLIF(BTRIM(l.treatment_interest),'')=NULLIF(BTRIM(p.service_name),'')
        AND (SELECT id FROM leads WHERE contact_id=p.contact_id
          ORDER BY is_closed ASC,created_at DESC,id DESC LIMIT 1)=l.id
        AND anchor.created_at >= $6::timestamptz
        AND ($7='all' OR anchor.sent_by_username IS NOT NULL)
        AND (SELECT id FROM messages WHERE contact_id=p.contact_id AND role='user'
             ORDER BY created_at DESC,id DESC LIMIT 1)=latest.id
        AND now()<COALESCE(latest.source_created_at,latest.created_at)+interval '23 hours 50 minutes'
        AND EXISTS(SELECT 1 FROM messages third WHERE third.contact_id=p.contact_id
          AND third.automated_follow_up_for_message_id=p.anchor_id
          AND third.automated_follow_up_step=3
          AND third.whatsapp_accepted_at IS NOT NULL
          AND now()>=third.whatsapp_accepted_at+interval '${DUE_AFTER_THIRD_MINUTES} minutes')
        AND NOT EXISTS(SELECT 1 FROM messages pricing
          WHERE pricing.pricing_reminder_anchor_id=p.anchor_id
            AND (pricing.delivery_status IS NULL OR
              pricing.delivery_status IN ('pending','unknown','failed')))
    ) AS eligible`,
    [claimed.promptId,claimed.contact_id,claimed.anchor_id,claimed.inbound_id,
      claimed.whatsapp_number,activatedAt,triggerMode]
  );
  return result.rows[0]?.eligible===true;
}

async function markSent(id,status,database=pool) {
  await database.query(
    "UPDATE whatsapp_consent_prompts SET status=$2 WHERE id=$1 AND status='claimed'",
    [id,status]
  );
}

function parseResponseId(value) {
  const match=/^da_consent_(yes|no):([1-9]\d{0,15})$/.exec(String(value||""));
  if (!match) return null;
  return { decision:match[1]==="yes"?"accepted":"declined", promptId: Number(match[2]) };
}

// Must be called ONLY for Meta interactive.button_reply, never typed text.
async function recordButtonResponse({
  contactId,messageId,leadId,replyId,businessName,
}, { database=pool } = {}) {
  const parsed=parseResponseId(replyId);
  if (!parsed || !Number.isSafeInteger(Number(messageId))) return { handled:false };
  const client=await database.connect();
  try {
    await client.query("BEGIN");
    const prompt=(await client.query(
      `SELECT p.*,c.whatsapp_opt_out_at,c.whatsapp_marketing_opt_out_at,c.whatsapp_opt_in_at
       FROM whatsapp_consent_prompts p JOIN contacts c ON c.id=p.contact_id
       WHERE p.id=$1 AND p.contact_id=$2 AND p.lead_id=$3 FOR UPDATE OF p`,
       [parsed.promptId,contactId,leadId]
    )).rows[0];
    const incoming=(await client.query(
      `SELECT id,role,whatsapp_message_id,content,is_forwarded,media_mime_type,
       COALESCE(source_created_at,created_at) AS sent_at
       FROM messages WHERE id=$1 AND contact_id=$2`,[messageId,contactId]
    )).rows[0];
    // If a worker crashed after committing the button decision but before
    // completing the inbound job, acknowledge the replay without repeating
    // consent writes or letting the AI reply to a one-tap response.
    if (prompt && incoming && Number(prompt.response_message_id)===Number(messageId) &&
        prompt.decision===parsed.decision) {
      await client.query("ROLLBACK");
      return {handled:true,decision:parsed.decision,alreadyRecorded:true};
    }
    if (!prompt || !incoming || incoming.role!=="user" || !incoming.whatsapp_message_id ||
        incoming.is_forwarded || incoming.media_mime_type || !prompt.message_id ||
        prompt.status==="failed" || prompt.response_message_id ||
        prompt.whatsapp_opt_out_at) {
      await client.query("ROLLBACK");return {handled:false};
    }
    const sentAt=new Date(incoming.sent_at);
    if (!Number.isFinite(sentAt.getTime()) ||
        sentAt.getTime()<new Date(prompt.created_at).getTime() ||
        (prompt.whatsapp_opt_in_at && sentAt<=new Date(prompt.whatsapp_opt_in_at)) ||
        (prompt.whatsapp_marketing_opt_out_at && sentAt<=new Date(prompt.whatsapp_marketing_opt_out_at))) {
      await client.query("ROLLBACK");return {handled:false};
    }
    if (parsed.decision==="accepted") {
      const inserted=await client.query(
        `INSERT INTO whatsapp_marketing_consent_events
         (contact_id,lead_id,source,recorded_by,message_id,provider_message_id,
          message_text,business_name,consent_scope,consent_category,
          consented_at,consent_method,consent_service)
         VALUES($1,$2,'customer_whatsapp_button',NULL,$3,$4,$5,$6,$7,$8,$9,'customer_whatsapp_interactive_button',$10)
         ON CONFLICT DO NOTHING RETURNING id`,
        [contactId,leadId,messageId,incoming.whatsapp_message_id,
          incoming.content,businessName,CONSENT_SCOPE,CONSENT_CATEGORY,
          sentAt.toISOString(),prompt.service_name]
      );
      if (inserted.rowCount!==1) {
        await client.query("ROLLBACK");return {handled:false};
      }
      await client.query(
        `UPDATE contacts SET whatsapp_opt_in_at=$2,
         whatsapp_opt_in_source='customer_whatsapp_button',
         whatsapp_marketing_opt_out_at=NULL,whatsapp_marketing_opt_out_source=NULL,
         updated_at=now() WHERE id=$1 AND channel='whatsapp'`,
        [contactId,sentAt.toISOString()]
      );
      await client.query(
        "UPDATE leads SET marketing_consent='opted_in',updated_at=now() WHERE id=$1 AND contact_id=$2",
        [leadId,contactId]);
    } else {
      // Declining this prompt does not create consent and is not an all-channel STOP.
      await client.query(
        "UPDATE leads SET marketing_consent='opted_out',updated_at=now() WHERE id=$1 AND contact_id=$2",
        [leadId,contactId]);
    }
    await client.query(
      `UPDATE whatsapp_consent_prompts SET response_message_id=$2,
       decision=$3,responded_at=$4 WHERE id=$1`,
      [prompt.id,messageId,parsed.decision,sentAt.toISOString()]
    );
    await client.query("COMMIT");
    return {handled:true,decision:parsed.decision};
  } catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}
  finally{client.release();}
}

module.exports={
  DUE_AFTER_THIRD_MINUTES,CANDIDATES_SQL,
  listCandidates,claim,stillEligible,markSent,
  parseResponseId,recordButtonResponse,
};
