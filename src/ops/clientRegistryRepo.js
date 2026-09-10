function rowToClient(row = {}) {
  return {
    clientSlug: row.client_slug,
    displayName: row.display_name,
    baseUrl: row.base_url,
    industry: row.industry || null,
    purchasedChannels: Array.isArray(row.purchased_channels) ? row.purchased_channels : [],
    tokenEnvKey: row.token_env_key,
    render: {
      serviceId: row.render_service_id || null,
      serviceName: row.render_service_name || null,
    },
    neon: {
      projectId: row.neon_project_id || null,
      projectName: row.neon_project_name || null,
    },
    provisionedCommitSha: row.provisioned_commit_sha || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    lastPollAt: row.last_poll_at || null,
    lastSuccessAt: row.last_success_at || null,
    lastHttpStatus: row.last_http_status == null ? null : Number(row.last_http_status),
    lastStatus: row.last_status || null,
    lastSchemaVersion: row.last_schema_version == null ? null : Number(row.last_schema_version),
    lastSnapshot: row.last_snapshot || null,
    lastError: row.last_error || null,
  };
}

function clientValues(client) {
  return [
    client.clientSlug,
    client.displayName,
    client.baseUrl,
    client.industry || null,
    JSON.stringify(client.purchasedChannels || []),
    client.tokenEnvKey,
    client.render?.serviceId || null,
    client.render?.serviceName || null,
    client.neon?.projectId || null,
    client.neon?.projectName || null,
    client.provisionedCommitSha || null,
  ];
}

const INSERT_COLUMNS = `
  client_slug,
  display_name,
  base_url,
  industry,
  purchased_channels,
  token_env_key,
  render_service_id,
  render_service_name,
  neon_project_id,
  neon_project_name,
  provisioned_commit_sha,
  updated_at
`;

function createClientRegistryRepo(queryable) {
  if (!queryable?.query) throw new Error("Ops Registry repository requires a Postgres queryable.");

  async function listClients() {
    const result = await queryable.query(`
      SELECT *
      FROM ops_clients
      ORDER BY LOWER(display_name), client_slug
    `);
    return result.rows.map(rowToClient);
  }

  async function getClient(clientSlug) {
    const result = await queryable.query(
      `SELECT * FROM ops_clients WHERE client_slug = $1`,
      [clientSlug],
    );
    return result.rows[0] ? rowToClient(result.rows[0]) : null;
  }

  async function insertClient(client) {
    const result = await queryable.query(
      `INSERT INTO ops_clients (${INSERT_COLUMNS})
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,NOW())
       RETURNING *`,
      clientValues(client),
    );
    return rowToClient(result.rows[0]);
  }

  async function upsertClient(client) {
    const result = await queryable.query(
      `INSERT INTO ops_clients (${INSERT_COLUMNS})
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (client_slug) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         base_url = EXCLUDED.base_url,
         industry = EXCLUDED.industry,
         purchased_channels = EXCLUDED.purchased_channels,
         token_env_key = EXCLUDED.token_env_key,
         render_service_id = EXCLUDED.render_service_id,
         render_service_name = EXCLUDED.render_service_name,
         neon_project_id = EXCLUDED.neon_project_id,
         neon_project_name = EXCLUDED.neon_project_name,
         provisioned_commit_sha = EXCLUDED.provisioned_commit_sha,
         updated_at = NOW()
       RETURNING *`,
      clientValues(client),
    );
    return rowToClient(result.rows[0]);
  }

  async function recordPollSuccess(clientSlug, {
    httpStatus = 200,
    snapshot,
    polledAt = new Date(),
  }) {
    const result = await queryable.query(
      `UPDATE ops_clients
       SET last_poll_at = $2,
           last_success_at = $2,
           last_http_status = $3,
           last_status = $4,
           last_schema_version = $5,
           last_snapshot = $6::jsonb,
           last_error = NULL,
           updated_at = NOW()
       WHERE client_slug = $1
         AND (last_poll_at IS NULL OR last_poll_at <= $2)
       RETURNING *`,
      [
        clientSlug,
        polledAt,
        httpStatus,
        snapshot?.readiness?.status || "unknown",
        Number(snapshot?.schemaVersion) || null,
        JSON.stringify(snapshot),
      ],
    );
    return result.rows[0] ? rowToClient(result.rows[0]) : null;
  }

  async function recordPollFailure(clientSlug, {
    httpStatus = null,
    error,
    polledAt = new Date(),
  }) {
    const result = await queryable.query(
      `UPDATE ops_clients
       SET last_poll_at = $2,
           last_http_status = $3,
           last_error = $4,
           updated_at = NOW()
       WHERE client_slug = $1
         AND (last_poll_at IS NULL OR last_poll_at <= $2)
       RETURNING *`,
      [clientSlug, polledAt, httpStatus, String(error || "Polling failed").slice(0, 1000)],
    );
    return result.rows[0] ? rowToClient(result.rows[0]) : null;
  }

  return {
    getClient,
    insertClient,
    listClients,
    recordPollFailure,
    recordPollSuccess,
    upsertClient,
  };
}

module.exports = {
  createClientRegistryRepo,
  rowToClient,
};
