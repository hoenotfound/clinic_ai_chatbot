function normalizeChannel(value) {
  const channel = String(value || "").trim().toLowerCase();
  if (!["facebook", "instagram"].includes(channel)) {
    throw new Error(`Unsupported Meta webhook route channel: ${value || "missing"}`);
  }
  return channel;
}

function normalizeAssetId(value) {
  const assetId = String(value || "").trim();
  if (!assetId) throw new Error("Meta webhook route asset ID is required.");
  return assetId;
}

function normalizeClientSlug(value) {
  const slug = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("Meta webhook route requires a normalized client slug.");
  }
  return slug;
}

function normalizeTargetBaseUrl(value) {
  const raw = String(value || "").trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error("Meta webhook route target URL is invalid.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Meta webhook route target URL must not contain credentials.");
  }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:") {
    if (!(local && parsed.protocol === "http:")) {
      throw new Error("Meta webhook route target URL must use HTTPS.");
    }
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function rowToRoute(row = {}) {
  return {
    clientSlug: row.client_slug,
    channel: row.channel,
    assetId: row.asset_id,
    targetBaseUrl: row.target_base_url,
    enabled: row.enabled === true,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function createMetaWebhookRouteRepo(queryable) {
  if (!queryable?.query) throw new Error("Meta webhook route repository requires a Postgres queryable.");

  async function getRoute(channel, assetId) {
    const normalizedChannel = normalizeChannel(channel);
    const normalizedAssetId = normalizeAssetId(assetId);
    const result = await queryable.query(
      `SELECT *
       FROM meta_webhook_routes
       WHERE channel = $1 AND asset_id = $2`,
      [normalizedChannel, normalizedAssetId],
    );
    return result.rows[0] ? rowToRoute(result.rows[0]) : null;
  }

  async function getRoutes(channel, assetIds) {
    const normalizedChannel = normalizeChannel(channel);
    const ids = [...new Set((assetIds || []).map(normalizeAssetId))];
    if (!ids.length) return [];
    const result = await queryable.query(
      `SELECT *
       FROM meta_webhook_routes
       WHERE channel = $1 AND asset_id = ANY($2::text[])
       ORDER BY client_slug, asset_id`,
      [normalizedChannel, ids],
    );
    return result.rows.map(rowToRoute);
  }

  async function listClientRoutes(clientSlug) {
    const slug = normalizeClientSlug(clientSlug);
    const result = await queryable.query(
      `SELECT *
       FROM meta_webhook_routes
       WHERE client_slug = $1
       ORDER BY channel, asset_id`,
      [slug],
    );
    return result.rows.map(rowToRoute);
  }

  async function upsertRoute({
    clientSlug,
    channel,
    assetId,
    targetBaseUrl,
    enabled = true,
  }) {
    const slug = normalizeClientSlug(clientSlug);
    const normalizedChannel = normalizeChannel(channel);
    const normalizedAssetId = normalizeAssetId(assetId);
    const target = normalizeTargetBaseUrl(targetBaseUrl);

    const result = await queryable.query(
      `INSERT INTO meta_webhook_routes (
         client_slug, channel, asset_id, target_base_url, enabled, updated_at
       ) VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (channel, asset_id) DO UPDATE SET
         client_slug = EXCLUDED.client_slug,
         target_base_url = EXCLUDED.target_base_url,
         enabled = EXCLUDED.enabled,
         updated_at = NOW()
       RETURNING *`,
      [slug, normalizedChannel, normalizedAssetId, target, enabled === true],
    );
    return rowToRoute(result.rows[0]);
  }

  async function setClientRoutesEnabled(clientSlug, enabled) {
    const slug = normalizeClientSlug(clientSlug);
    const result = await queryable.query(
      `UPDATE meta_webhook_routes
       SET enabled = $2, updated_at = NOW()
       WHERE client_slug = $1
       RETURNING *`,
      [slug, enabled === true],
    );
    return result.rows.map(rowToRoute);
  }

  async function deleteClientRoute(clientSlug, channel, assetId = null) {
    const slug = normalizeClientSlug(clientSlug);
    const normalizedChannel = normalizeChannel(channel);
    const normalizedAssetId = assetId == null ? null : normalizeAssetId(assetId);
    const result = normalizedAssetId
      ? await queryable.query(
          `DELETE FROM meta_webhook_routes
           WHERE client_slug = $1 AND channel = $2 AND asset_id = $3
           RETURNING *`,
          [slug, normalizedChannel, normalizedAssetId],
        )
      : await queryable.query(
          `DELETE FROM meta_webhook_routes
           WHERE client_slug = $1 AND channel = $2
           RETURNING *`,
          [slug, normalizedChannel],
        );
    return result.rows.map(rowToRoute);
  }

  return {
    deleteClientRoute,
    getRoute,
    getRoutes,
    listClientRoutes,
    setClientRoutesEnabled,
    upsertRoute,
  };
}

module.exports = {
  createMetaWebhookRouteRepo,
  normalizeAssetId,
  normalizeChannel,
  normalizeClientSlug,
  normalizeTargetBaseUrl,
  rowToRoute,
};
