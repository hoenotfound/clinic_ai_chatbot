const { pool } = require("./db");
const { inferConfiguredServiceFromText } = require("../utils/serviceInterest");

const DEFAULT_ENRICHMENT_LEASE_MS = 5 * 60 * 1000;

function toJson(value) {
  return value == null ? null : JSON.stringify(value);
}

function clampPositiveInteger(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

async function savePending(channel, externalUserId, attribution, eventId = null) {
  if (!channel || !externalUserId || !attribution) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM pending_lead_attributions WHERE expires_at <= now()`);
    const result = await client.query(
      `INSERT INTO pending_lead_attributions (
         channel, external_user_id, attribution, event_id, created_at, expires_at
       )
       VALUES ($1, $2, $3::jsonb, $4, now(), now() + interval '7 days')
       ON CONFLICT (channel, external_user_id) DO UPDATE SET
         attribution = EXCLUDED.attribution,
         event_id = EXCLUDED.event_id,
         created_at = now(),
         expires_at = now() + interval '7 days'
       RETURNING *`,
      [
        channel,
        String(externalUserId),
        toJson(attribution),
        eventId ? String(eventId) : null,
      ]
    );
    await client.query("COMMIT");
    return result.rows[0] || null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function takePending(channel, externalUserId) {
  if (!channel || !externalUserId) return null;
  const result = await pool.query(
    `DELETE FROM pending_lead_attributions
     WHERE channel = $1
       AND external_user_id = $2
       AND expires_at > now()
     RETURNING attribution`,
    [channel, String(externalUserId)]
  );
  return result.rows[0]?.attribution || null;
}

async function cleanupExpiredPending() {
  await pool.query(`DELETE FROM pending_lead_attributions WHERE expires_at <= now()`);
}

async function getForLead(leadId) {
  const result = await pool.query(
    `SELECT * FROM lead_attributions WHERE lead_id = $1`,
    [leadId]
  );
  return result.rows[0] || null;
}

async function getForLeadIds(leadIds) {
  const ids = [...new Set((leadIds || []).map(Number).filter(Number.isSafeInteger))];
  if (!ids.length) return new Map();
  const result = await pool.query(
    `SELECT * FROM lead_attributions WHERE lead_id = ANY($1::int[])`,
    [ids]
  );
  return new Map(result.rows.map((row) => [Number(row.lead_id), row]));
}

async function getById(attributionId) {
  const id = Number(attributionId);
  if (!Number.isSafeInteger(id)) return null;
  const result = await pool.query(
    `SELECT * FROM lead_attributions WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function createFirstTouch({ leadId, firstMessageId, attribution }) {
  if (!leadId || !attribution?.source || !attribution?.channel) return null;

  const attributedTreatment = attribution.source === "meta_ads"
    ? inferConfiguredServiceFromText(attribution.adName)
    : null;
  const enrichmentStatus = attribution.source === "meta_ads" && attribution.adId
    ? "pending"
    : "not_applicable";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO lead_attributions (
         lead_id, first_message_id, source, platform, channel,
         meta_ad_id, meta_source_id, meta_source_type,
         referral_ref, referral_source, referral_type, ctwa_clid,
         source_url, headline, body, media_type, media_url,
         campaign_id, campaign_name, adset_id, adset_name, ad_name,
         enrichment_status, raw_referral, attributed_at, updated_at
       )
       VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8,
         $9, $10, $11, $12,
         $13, $14, $15, $16, $17,
         $18, $19, $20, $21, $22,
         $23, $24::jsonb, now(), now()
       )
       ON CONFLICT (lead_id) DO NOTHING
       RETURNING *`,
      [
        leadId,
        firstMessageId || null,
        attribution.source,
        attribution.platform || null,
        attribution.channel,
        attribution.adId || null,
        attribution.sourceId || null,
        attribution.sourceType || null,
        attribution.referralRef || null,
        attribution.referralSource || null,
        attribution.referralType || null,
        attribution.ctwaClid || null,
        attribution.sourceUrl || null,
        attribution.headline || null,
        attribution.body || null,
        attribution.mediaType || null,
        attribution.mediaUrl || null,
        attribution.campaignId || null,
        attribution.campaignName || null,
        attribution.adsetId || null,
        attribution.adsetName || null,
        attribution.adName || null,
        enrichmentStatus,
        toJson(attribution.rawReferral),
      ]
    );

    const inserted = result.rows[0] || null;
    if (inserted) {
      // Preserve staff/AI-entered CRM facts. First-touch attribution only fills
      // blanks. When Meta already supplied an ad name, use the configured service
      // named by that ad as the lead's baseline treatment interest.
      await client.query(
        `UPDATE leads
         SET source = CASE WHEN NULLIF(BTRIM(source), '') IS NULL THEN $2 ELSE source END,
             campaign_name = CASE
               WHEN NULLIF(BTRIM(campaign_name), '') IS NULL AND $3::text IS NOT NULL THEN $3
               ELSE campaign_name
             END,
             treatment_interest = CASE
               WHEN NULLIF(BTRIM(treatment_interest), '') IS NULL AND $4::text IS NOT NULL THEN $4
               ELSE treatment_interest
             END,
             updated_at = now()
         WHERE id = $1`,
        [
          leadId,
          attribution.source,
          attribution.campaignName || null,
          attributedTreatment,
        ]
      );

      await client.query(
        `INSERT INTO lead_activities (
           lead_id, activity_type, description, actor, metadata
         ) VALUES ($1, 'attribution', $2, 'Automation', $3::jsonb)`,
        [
          leadId,
          attribution.source === "meta_ads"
            ? `Lead attributed to Meta Ads${attribution.adId ? ` · Ad ${attribution.adId}` : ""}.`
            : `Lead source captured: ${attribution.source}.`,
          toJson({
            source: attribution.source,
            channel: attribution.channel,
            metaAdId: attribution.adId || null,
            headline: attribution.headline || null,
          }),
        ]
      );
    }

    const existing = inserted || await getForLeadWithClient(client, leadId);
    await client.query("COMMIT");
    return existing;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}


/**
 * Repair a false "direct" first touch ONLY when Meta first delivered an
 * unreadable 131060 placeholder and immediately followed it with a provider-
 * verified CTWA ad message in the same secondary sender conversation.
 *
 * Do not reattribute genuine direct leads, old chats, or later ad clicks.
 * All evidence is verified inside the single transaction; a repeated webhook
 * cannot update the row twice. This does not replay any customer message.
 */
async function recoverUnavailableFirstTouchAd({
  leadId, inboundMessageId, attribution,
}, database = pool) {
  const lead = Number(leadId);
  const inbound = Number(inboundMessageId);
  if (!Number.isSafeInteger(lead) || lead <= 0 ||
      !Number.isSafeInteger(inbound) || inbound <= 0 ||
      attribution?.source !== "meta_ads" ||
      attribution?.channel !== "whatsapp" ||
      !attribution?.adId) return null;

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE lead_attributions la
       SET first_message_id=verified.id,
           source='meta_ads', platform=$4,
           meta_ad_id=$3, meta_source_id=$5, meta_source_type=$6,
           referral_ref=$7, referral_source=$8, referral_type=$9,
           ctwa_clid=$10, source_url=$11, headline=$12, body=$13,
           media_type=$14, media_url=$15, campaign_id=$16,
           campaign_name=$17, adset_id=$18, adset_name=$19, ad_name=$20,
           raw_referral=$21::jsonb, attributed_at=verified.created_at,
           enrichment_status='pending', enrichment_attempts=0,
           enrichment_last_error=NULL, enrichment_next_attempt_at=NULL,
           updated_at=now()
       FROM leads l, messages initial, messages verified
       WHERE la.lead_id=$1 AND l.id=la.lead_id
         AND l.is_closed IS NOT TRUE
         AND la.source='whatsapp_unattributed'
         AND la.channel='whatsapp' AND la.meta_ad_id IS NULL
         AND l.source='whatsapp_unattributed'
         AND initial.id=l.started_message_id
         AND initial.id=la.first_message_id
         AND initial.contact_id=l.contact_id
         AND initial.role='user' AND initial.whatsapp_message_id IS NOT NULL
         AND verified.id=$2 AND verified.contact_id=l.contact_id
         AND verified.role='user' AND verified.whatsapp_message_id IS NOT NULL
         AND NULLIF(BTRIM(verified.content),'') IS NOT NULL
         AND (verified.created_at,verified.id)>(initial.created_at,initial.id)
         AND initial.source_created_at IS NOT NULL
         AND verified.source_created_at IS NOT NULL
         AND verified.source_created_at>=initial.source_created_at
         AND verified.source_created_at<=initial.source_created_at+INTERVAL '10 minutes'
         AND verified.created_at<=initial.created_at+INTERVAL '10 minutes'
         -- Proof of the unavailable payload must come from the accepted
         -- Meta webhook, not a text placeholder that somebody typed.
         AND EXISTS (
           SELECT 1 FROM inbound_processing_jobs initial_job
           WHERE initial_job.message_id=initial.id
             AND initial_job.channel='whatsapp'
             AND initial_job.incoming_payload->>'unsupportedType'='unsupported'
             AND initial_job.incoming_payload->'unsupportedErrors'
                 @> '[{"code":131060}]'::jsonb
         )
         -- The second message must carry an actual ad referral from Meta.
         AND EXISTS (
           SELECT 1 FROM inbound_processing_jobs verified_job
           WHERE verified_job.message_id=verified.id
             AND verified_job.channel='whatsapp'
             AND verified_job.incoming_payload->'attribution'->>'adId'=$3
             AND verified_job.incoming_payload->'attribution'->>'sourceType'='ad'
             AND NULLIF(BTRIM(verified_job.incoming_payload->>'text'),'') IS NOT NULL
         )
         AND EXISTS (
           SELECT 1 FROM whatsapp_sender_message_context first_context
           JOIN whatsapp_sender_message_context ad_context
             ON ad_context.conversation_id=first_context.conversation_id
           JOIN whatsapp_sender_conversations sc
             ON sc.id=first_context.conversation_id
           JOIN whatsapp_sender_accounts sa ON sa.id=sc.sender_id
           WHERE first_context.message_id=initial.id
             AND ad_context.message_id=verified.id
             AND sc.contact_id=l.contact_id
             AND sc.state='bound'
             AND sa.sender_key='neutro_secondary' AND sa.state='active'
         )
         AND NOT EXISTS (
           SELECT 1 FROM messages between_messages
           WHERE between_messages.contact_id=l.contact_id
             AND (between_messages.created_at,between_messages.id)
                 >(initial.created_at,initial.id)
             AND (between_messages.created_at,between_messages.id)
                 <(verified.created_at,verified.id)
         )
       RETURNING la.*`,
      [
        lead, inbound, String(attribution.adId),
        attribution.platform || "meta",
        attribution.sourceId || null, attribution.sourceType || null,
        attribution.referralRef || null, attribution.referralSource || null,
        attribution.referralType || null, attribution.ctwaClid || null,
        attribution.sourceUrl || null, attribution.headline || null,
        attribution.body || null, attribution.mediaType || null,
        attribution.mediaUrl || null, attribution.campaignId || null,
        attribution.campaignName || null, attribution.adsetId || null,
        attribution.adsetName || null, toJson(attribution.rawReferral),
      ]
    );
    const repaired = result.rows[0] || null;
    if (repaired) {
      // Only correct the false direct source. Never overwrite staff decisions.
      await client.query(
        `UPDATE leads
         SET source='meta_ads',
             campaign_name=CASE
               WHEN NULLIF(BTRIM(campaign_name),'') IS NULL THEN $2
               ELSE campaign_name END,
             treatment_interest=CASE
               WHEN NULLIF(BTRIM(treatment_interest),'') IS NULL THEN $3
               ELSE treatment_interest END,
             updated_at=now()
         WHERE id=$1 AND source='whatsapp_unattributed'`,
        [lead, attribution.campaignName || null,
          inferConfiguredServiceFromText(attribution.adName)]
      );
      await client.query(
        `INSERT INTO lead_activities
           (lead_id,activity_type,description,actor,metadata)
         VALUES ($1,'attribution','Meta 131060 unavailable entry: recovered verified first readable ad.', 'Automation',$2::jsonb)`,
        [lead, toJson({
          source: "meta_ads", metaAdId: String(attribution.adId),
          verifiedInboundMessageId: inbound,
          unavailableOriginalMessageId: Number(repaired.first_message_id) === inbound
            ? null : Number(repaired.first_message_id),
        })]
      );
    }
    await client.query("COMMIT");
    return repaired;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getForContactCurrentLead(contactId) {
  const id = Number(contactId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;

  const result = await pool.query(
    `SELECT
       l.id AS lead_id,
       l.contact_id,
       l.temperature,
       l.treatment_interest,
       l.appointment_status,
       l.estimated_value,
       l.owner_username,
       l.branch_name,
       s.name AS stage_name,
       s.stage_type,
       la.source,
       la.channel AS attribution_channel,
       la.platform,
       la.meta_ad_id,
       COALESCE(la.meta_account_id, ah.account_id) AS meta_account_id,
       COALESCE(la.campaign_id, ah.campaign_id) AS campaign_id,
       COALESCE(la.campaign_name, ah.campaign_name) AS campaign_name,
       COALESCE(la.adset_id, ah.adset_id) AS adset_id,
       COALESCE(la.adset_name, ah.adset_name) AS adset_name,
       COALESCE(la.ad_name, ah.ad_name) AS ad_name,
       la.ctwa_clid,
       la.headline,
       la.body,
       la.media_type,
       la.media_url,
       la.enrichment_status,
       la.enriched_at,
       la.attributed_at
     FROM leads l
     JOIN pipeline_stages s ON s.id = l.stage_id
     LEFT JOIN lead_attributions la ON la.lead_id = l.id
     LEFT JOIN LATERAL (
       SELECT
         mi.account_id,
         mi.campaign_id,
         mi.campaign_name,
         mi.adset_id,
         mi.adset_name,
         mi.ad_name
       FROM meta_ad_insights_daily mi
       WHERE mi.ad_id = la.meta_ad_id
       ORDER BY mi.insight_date DESC, mi.updated_at DESC
       LIMIT 1
     ) ah ON true
     WHERE l.contact_id = $1
     ORDER BY l.is_closed ASC, l.created_at DESC, l.id DESC
     LIMIT 1`,
    [id]
  );
  return result.rows[0] || null;
}

async function getForLeadWithClient(client, leadId) {
  const result = await client.query(
    `SELECT * FROM lead_attributions WHERE lead_id = $1`,
    [leadId]
  );
  return result.rows[0] || null;
}

async function claimMetaEnrichmentById(
  attributionId,
  leaseMs = DEFAULT_ENRICHMENT_LEASE_MS
) {
  const id = Number(attributionId);
  if (!Number.isSafeInteger(id)) return null;
  const lease = clampPositiveInteger(leaseMs, DEFAULT_ENRICHMENT_LEASE_MS, 30 * 60 * 1000);
  const result = await pool.query(
    `UPDATE lead_attributions
     SET enrichment_attempts = enrichment_attempts + 1,
         enrichment_last_attempt_at = now(),
         enrichment_next_attempt_at = now() + ($2::bigint * interval '1 millisecond'),
         enrichment_last_error = NULL,
         updated_at = now()
     WHERE id = $1
       AND enrichment_status = 'pending'
       AND meta_ad_id IS NOT NULL
       AND (enrichment_next_attempt_at IS NULL OR enrichment_next_attempt_at <= now())
     RETURNING *`,
    [id, lease]
  );
  return result.rows[0] || null;
}

async function claimMetaEnrichmentBatch(
  limit = 10,
  leaseMs = DEFAULT_ENRICHMENT_LEASE_MS
) {
  const batchSize = clampPositiveInteger(limit, 10, 50);
  const lease = clampPositiveInteger(leaseMs, DEFAULT_ENRICHMENT_LEASE_MS, 30 * 60 * 1000);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `WITH candidates AS (
         SELECT id
         FROM lead_attributions
         WHERE enrichment_status = 'pending'
           AND meta_ad_id IS NOT NULL
           AND (enrichment_next_attempt_at IS NULL OR enrichment_next_attempt_at <= now())
         ORDER BY attributed_at ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE lead_attributions AS la
       SET enrichment_attempts = la.enrichment_attempts + 1,
           enrichment_last_attempt_at = now(),
           enrichment_next_attempt_at = now() + ($2::bigint * interval '1 millisecond'),
           enrichment_last_error = NULL,
           updated_at = now()
       FROM candidates
       WHERE la.id = candidates.id
       RETURNING la.*`,
      [batchSize, lease]
    );
    await client.query("COMMIT");
    return result.rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function markMetaEnrichmentDeferred(attributionId, errorText, delayMs) {
  const id = Number(attributionId);
  if (!Number.isSafeInteger(id)) return null;
  const delay = clampPositiveInteger(delayMs, 15 * 60 * 1000, 24 * 60 * 60 * 1000);
  const message = String(errorText || "Meta Ads enrichment failed.").slice(0, 1000);
  const result = await pool.query(
    `UPDATE lead_attributions
     SET enrichment_status = 'pending',
         enrichment_last_error = $2,
         enrichment_next_attempt_at = now() + ($3::bigint * interval '1 millisecond'),
         updated_at = now()
     WHERE id = $1
       AND enriched_at IS NULL
     RETURNING *`,
    [id, message, delay]
  );
  return result.rows[0] || null;
}

async function markMetaEnrichmentSuccess(attributionId, details) {
  const id = Number(attributionId);
  if (!Number.isSafeInteger(id) || !details?.adId) return null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE lead_attributions
       SET meta_account_id = COALESCE($2, meta_account_id),
           ad_name = COALESCE($3, ad_name),
           adset_id = COALESCE($4, adset_id),
           adset_name = COALESCE($5, adset_name),
           campaign_id = COALESCE($6, campaign_id),
           campaign_name = COALESCE($7, campaign_name),
           enrichment_status = 'enriched',
           enrichment_last_error = NULL,
           enrichment_next_attempt_at = NULL,
           enriched_at = now(),
           updated_at = now()
       WHERE id = $1
         AND meta_ad_id = $8
         AND enrichment_status = 'pending'
       RETURNING *`,
      [
        id,
        details.accountId || null,
        details.adName || null,
        details.adsetId || null,
        details.adsetName || null,
        details.campaignId || null,
        details.campaignName || null,
        String(details.adId),
      ]
    );

    const updated = result.rows[0] || null;
    if (updated) {
      // The immutable attribution row receives the API truth. Keep any existing
      // CRM value authoritative, but seed blank campaign/service fields from
      // the enriched ad. Conversation scoring can later replace the baseline
      // treatment interest when the customer explicitly switches services.
      const attributedTreatment = inferConfiguredServiceFromText(details.adName);
      if (details.campaignName || attributedTreatment) {
        await client.query(
          `UPDATE leads
           SET campaign_name = CASE
                 WHEN NULLIF(BTRIM(campaign_name), '') IS NULL AND $2::text IS NOT NULL THEN $2
                 ELSE campaign_name
               END,
               treatment_interest = CASE
                 WHEN NULLIF(BTRIM(treatment_interest), '') IS NULL AND $3::text IS NOT NULL THEN $3
                 ELSE treatment_interest
               END,
               updated_at = now()
           WHERE id = $1`,
          [
            updated.lead_id,
            details.campaignName || null,
            attributedTreatment,
          ]
        );
      }

      await client.query(
        `INSERT INTO lead_activities (
           lead_id, activity_type, description, actor, metadata
         ) VALUES ($1, 'attribution_enriched', $2, 'Automation', $3::jsonb)`,
        [
          updated.lead_id,
          `Meta ad details synced${details.adName ? ` · ${details.adName}` : ""}.`,
          toJson({
            metaAdId: details.adId,
            adName: details.adName || null,
            adsetId: details.adsetId || null,
            adsetName: details.adsetName || null,
            campaignId: details.campaignId || null,
            campaignName: details.campaignName || null,
            accountId: details.accountId || null,
          }),
        ]
      );
    }

    await client.query("COMMIT");
    return updated;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  DEFAULT_ENRICHMENT_LEASE_MS,
  savePending,
  takePending,
  cleanupExpiredPending,
  getForLead,
  getForLeadIds,
  getForContactCurrentLead,
  getById,
  createFirstTouch,
  recoverUnavailableFirstTouchAd,
  claimMetaEnrichmentById,
  claimMetaEnrichmentBatch,
  markMetaEnrichmentDeferred,
  markMetaEnrichmentSuccess,
};
