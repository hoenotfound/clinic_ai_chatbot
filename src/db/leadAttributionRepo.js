const { pool } = require("./db");

const DEFAULT_ENRICHMENT_LEASE_MS = 5 * 60 * 1000;

function toJson(value) {
  return value == null ? null : JSON.stringify(value);
}

function clampPositiveInteger(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

async function savePending(channel, externalUserId, attribution) {
  if (!channel || !externalUserId || !attribution) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM pending_lead_attributions WHERE expires_at <= now()`);
    const result = await client.query(
      `INSERT INTO pending_lead_attributions (
         channel, external_user_id, attribution, created_at, expires_at
       )
       VALUES ($1, $2, $3::jsonb, now(), now() + interval '7 days')
       ON CONFLICT (channel, external_user_id) DO UPDATE SET
         attribution = EXCLUDED.attribution,
         created_at = now(),
         expires_at = now() + interval '7 days'
       RETURNING *`,
      [channel, String(externalUserId), toJson(attribution)]
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
      // Preserve a staff-entered source/campaign. Automatic attribution only
      // fills blank summary fields on the lead for existing Pipeline/Analytics
      // compatibility; the detailed immutable attribution remains in its table.
      await client.query(
        `UPDATE leads
         SET source = CASE WHEN NULLIF(BTRIM(source), '') IS NULL THEN $2 ELSE source END,
             campaign_name = CASE
               WHEN NULLIF(BTRIM(campaign_name), '') IS NULL AND $3::text IS NOT NULL THEN $3
               ELSE campaign_name
             END,
             updated_at = now()
         WHERE id = $1`,
        [leadId, attribution.source, attribution.campaignName || null]
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
      // The immutable attribution row receives the API truth. Keep a manual
      // campaign override on the lead authoritative; only fill a blank field.
      if (details.campaignName) {
        await client.query(
          `UPDATE leads
           SET campaign_name = $2,
               updated_at = now()
           WHERE id = $1
             AND NULLIF(BTRIM(campaign_name), '') IS NULL`,
          [updated.lead_id, details.campaignName]
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
  getById,
  createFirstTouch,
  claimMetaEnrichmentById,
  claimMetaEnrichmentBatch,
  markMetaEnrichmentDeferred,
  markMetaEnrichmentSuccess,
};
