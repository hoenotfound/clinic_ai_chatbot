const { pool } = require("./db");

function toJson(value) {
  return value == null ? null : JSON.stringify(value);
}

async function savePending(channel, externalUserId, attribution) {
  if (!channel || !externalUserId || !attribution) return null;
  const result = await pool.query(
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
  return result.rows[0] || null;
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

async function createFirstTouch({ leadId, firstMessageId, attribution }) {
  if (!leadId || !attribution?.source || !attribution?.channel) return null;

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
         raw_referral, attributed_at, updated_at
       )
       VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8,
         $9, $10, $11, $12,
         $13, $14, $15, $16, $17,
         $18, $19, $20, $21, $22,
         $23::jsonb, now(), now()
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

    await client.query("COMMIT");
    return inserted || await getForLeadWithClient(client, leadId);
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

module.exports = {
  savePending,
  takePending,
  cleanupExpiredPending,
  getForLead,
  getForLeadIds,
  createFirstTouch,
};