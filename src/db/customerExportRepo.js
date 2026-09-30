const { pool } = require("./db");

function normalizeAllowedContactIds(value) {
  if (value === null) return null;
  return [...new Set((value || []).map(Number).filter(Number.isSafeInteger))];
}

function normalizeAssignment(value) {
  const assignment = String(value || "all").trim();
  if (["all", "mine", "unassigned"].includes(assignment)) return assignment;
  if (assignment.startsWith("owner:") && assignment.slice("owner:".length).trim()) {
    return assignment;
  }
  return "all";
}

async function listCustomerExportRows({
  search = "",
  assignment = "all",
  currentUsername = null,
  allowedContactIds = null,
  applyCurrentView = false,
} = {}) {
  const accessibleIds = normalizeAllowedContactIds(allowedContactIds);
  if (accessibleIds && accessibleIds.length === 0) return [];

  const params = [];
  const conditions = [];
  const addParam = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (accessibleIds) {
    conditions.push(`c.id = ANY(${addParam(accessibleIds)}::int[])`);
  }

  if (applyCurrentView) {
    const term = String(search || "").trim();
    if (term) {
      const ref = addParam(`%${term}%`);
      conditions.push(`(
        c.name ILIKE ${ref}
        OR c.whatsapp_profile_name ILIKE ${ref}
        OR c.whatsapp_number ILIKE ${ref}
        OR c.channel_user_id ILIKE ${ref}
      )`);
    }

    const normalizedAssignment = normalizeAssignment(assignment);
    if (normalizedAssignment === "mine" && currentUsername) {
      conditions.push(`current_lead.owner_username = ${addParam(currentUsername)}`);
    } else if (normalizedAssignment === "unassigned") {
      conditions.push("current_lead.owner_username IS NULL");
    } else if (normalizedAssignment.startsWith("owner:")) {
      conditions.push(
        `current_lead.owner_username = ${addParam(
          normalizedAssignment.slice("owner:".length)
        )}`
      );
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join("\n      AND ")}` : "";
  const result = await pool.query(
    `
    SELECT
      c.id AS contact_id,
      COALESCE(
        NULLIF(BTRIM(c.name), ''),
        NULLIF(BTRIM(c.whatsapp_profile_name), ''),
        CASE
          WHEN c.channel = 'facebook' THEN 'Facebook user'
          WHEN c.channel = 'instagram' THEN 'Instagram user'
          ELSE c.whatsapp_number
        END
      ) AS customer_name,
      c.channel,
      CASE WHEN c.channel = 'whatsapp' THEN c.whatsapp_number ELSE NULL END AS whatsapp_number,
      CASE WHEN c.channel IN ('facebook', 'instagram') THEN c.channel_user_id ELSE NULL END AS social_account_id,
      c.created_at AS customer_created_at,
      c.whatsapp_opt_in_at,
      c.whatsapp_opt_in_source,
      c.whatsapp_opt_out_at,
      c.whatsapp_opt_out_source,
      c.whatsapp_marketing_opt_out_at,
      c.whatsapp_marketing_opt_out_source,
      current_lead.id AS lead_id,
      current_lead.temperature,
      current_lead.branch_name,
      current_lead.owner_username,
      COALESCE(owner.display_name, current_lead.owner_username) AS owner_display_name,
      current_lead.treatment_interest,
      current_lead.estimated_value,
      current_lead.source AS lead_source,
      current_lead.campaign_name AS lead_campaign_name,
      current_lead.appointment_status,
      current_lead.appointment_at,
      current_lead.next_follow_up_at,
      current_lead.lost_reason,
      current_lead.marketing_consent,
      current_lead.created_at AS lead_created_at,
      stage.name AS stage_name,
      attribution.source AS attribution_source,
      attribution.platform AS attribution_platform,
      attribution.campaign_id,
      attribution.campaign_name AS attribution_campaign_name,
      attribution.adset_id,
      attribution.adset_name,
      attribution.meta_ad_id,
      attribution.ad_name,
      attribution.attributed_at,
      message_stats.message_count,
      message_stats.last_message_at,
      message_stats.latest_inbound_at,
      message_stats.latest_outbound_at
    FROM contacts c
    LEFT JOIN LATERAL (
      SELECT lead_choice.*
      FROM leads lead_choice
      WHERE lead_choice.contact_id = c.id
      ORDER BY
        lead_choice.is_closed ASC,
        lead_choice.created_at DESC,
        lead_choice.id DESC
      LIMIT 1
    ) current_lead ON true
    LEFT JOIN pipeline_stages stage ON stage.id = current_lead.stage_id
    LEFT JOIN users owner ON owner.username = current_lead.owner_username
    LEFT JOIN lead_attributions attribution ON attribution.lead_id = current_lead.id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS message_count,
        MAX(m.created_at) AS last_message_at,
        MAX(m.created_at) FILTER (WHERE m.role = 'user') AS latest_inbound_at,
        MAX(m.created_at) FILTER (WHERE m.role = 'assistant') AS latest_outbound_at
      FROM messages m
      WHERE m.contact_id = c.id
    ) message_stats ON true
    ${where}
    ORDER BY message_stats.last_message_at DESC NULLS LAST, c.created_at DESC, c.id DESC
    `,
    params
  );

  return result.rows;
}

async function recordCustomerExport({
  username,
  preset,
  scope,
  rowCount,
  filters = {},
}) {
  await pool.query(
    `INSERT INTO customer_data_exports (
       username, preset, scope, row_count, filters
     )
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [username, preset, scope, rowCount, JSON.stringify(filters || {})]
  );
}

module.exports = {
  listCustomerExportRows,
  normalizeAssignment,
  recordCustomerExport,
};
