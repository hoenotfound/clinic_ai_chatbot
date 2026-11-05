"use strict";

const { pool } = require("./db");
const { acceptedNormalOutboundSql } = require("../utils/normalOutboundProofSql");

// One bounded, WAL-verified in-memory index avoids transferring the same
// thousands of index rows again on consecutive paged Inbox requests.
// Only full-access reads share the cache. Scoped staff always query fresh.
// The cache never authorizes a contact or bypasses route permission rechecks.
const INDEX_CACHE_TTL_MS = 45 * 1000;
let cachedIndex = null;
async function currentWal() {
  try {
    const result = await pool.query("SELECT pg_current_wal_lsn()::text AS wal_lsn");
    return result.rows?.[0]?.wal_lsn || null;
  } catch {
    return null;
  }
}
function resetIndexCacheForTests() { cachedIndex = null; }

// Only used within the server to select page IDs and accurate, whole-Inbox
// filter counts. Never return its complete contact set to the browser.
async function listInboxPageIndex({ accessibleContactIds = null, query = "" } = {}) {
  if (accessibleContactIds !== null &&
      (!Array.isArray(accessibleContactIds) ||
       accessibleContactIds.some(id => !Number.isSafeInteger(id) || id <= 0))) {
    throw new TypeError("Invalid Inbox access scope");
  }
  if (accessibleContactIds?.length === 0) return [];

  // The caller has already recomputed the staff's access scope. Never cache
  // scoped rows; use a small read-only revision probe for full-access views.
  const cacheable = accessibleContactIds === null &&
    process.env.INBOX_INDEX_WAL_CACHE_ENABLED === "true";
  const normalizedQuery = String(query).trim().toLowerCase().slice(0, 160);
  const wal = cacheable ? await currentWal() : null;
  if (wal && cachedIndex?.wal === wal &&
      cachedIndex.query === normalizedQuery &&
      cachedIndex.expiresAt > Date.now()) {
    return cachedIndex.rows;
  }

  const multi = process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED === "true";
  const hideEmpty = multi && process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS !== "false";
  const scope = accessibleContactIds === null ? "" : "AND c.id = ANY($2::integer[])";
  const candidates = hideEmpty ? [
    "WITH eligible_inbox_contacts AS MATERIALIZED (",
    " SELECT c.id FROM contacts c WHERE TRUE " + scope,
    " AND NOT (c.whatsapp_sender_id IS NOT NULL",
    " AND EXISTS (SELECT 1 FROM whatsapp_sender_accounts account",
    "  WHERE account.id=c.whatsapp_sender_id AND account.coexistence_enabled=TRUE)",
    " AND NOT EXISTS (SELECT 1 FROM messages mx WHERE mx.contact_id=c.id)",
    " AND NOT EXISTS (SELECT 1 FROM leads lx WHERE lx.contact_id=c.id)",
    " AND c.is_unread IS DISTINCT FROM TRUE",
    " AND c.needs_attention IS DISTINCT FROM TRUE",
    " AND c.needs_follow_up IS DISTINCT FROM TRUE",
    " AND c.mode IS DISTINCT FROM 'human'))",
  ].join("\n") : "";
  const from = hideEmpty
    ? "eligible_inbox_contacts candidate JOIN contacts c ON c.id=candidate.id"
    : "contacts c";
  const params = [normalizedQuery];
  if (accessibleContactIds !== null) params.push(accessibleContactIds);

  const sql = [
    candidates,
    "SELECT c.id AS contact_id,c.name,c.whatsapp_profile_name,c.whatsapp_number,",
    " c.channel,c.created_at,c.mode,c.needs_attention,c.needs_follow_up,",
    " c.is_unread,c.inbox_archived_at,c.whatsapp_opt_out_at,",
    " c.whatsapp_marketing_opt_out_at,",
    (multi ? "sa.sender_key" : "NULL::text") + " AS whatsapp_sender_key,",
    (multi ? "sa.display_name" : "NULL::text") + " AS whatsapp_sender_display_name,",
    " lead.owner_username AS lead_owner_username,",
    " COALESCE(owner.display_name,lead.owner_username) AS lead_owner_display_name,",
    " latest.created_at AS last_message_at, latest.role AS last_message_role,",
    " inbound_source.latest_inbound_at,",
    " (last_inbound.id IS NOT NULL AND (accepted.id IS NULL",
    " OR (accepted.created_at,accepted.id) <= (last_inbound.created_at,last_inbound.id)",
    " )) AS has_unreplied,",
    " ($1::text = '' OR POSITION($1::text IN LOWER(CONCAT_WS(' ',",
    " c.name,c.whatsapp_profile_name,c.whatsapp_number,",
    " COALESCE(owner.display_name,lead.owner_username),lead.owner_username,",
    ...(multi ? [" sa.sender_key,sa.display_name,"] : []),
    " latest.content))) > 0) AS search_match",
    "FROM " + from,
    ...(multi ? [
      "LEFT JOIN whatsapp_sender_conversations sc",
      " ON sc.contact_id=c.id AND sc.state='bound'",
      "LEFT JOIN whatsapp_sender_accounts sa ON sa.id=sc.sender_id",
    ] : []),
    "LEFT JOIN LATERAL (",
    " SELECT l.owner_username FROM leads l WHERE l.contact_id=c.id",
    " ORDER BY l.is_closed ASC,l.created_at DESC,l.id DESC LIMIT 1",
    ") lead ON TRUE",
    "LEFT JOIN users owner ON owner.username=lead.owner_username",
    "LEFT JOIN LATERAL (",
    " SELECT m.content,m.role,m.created_at FROM messages m WHERE m.contact_id=c.id",
    " ORDER BY m.created_at DESC,m.id DESC LIMIT 1",
    ") latest ON TRUE",
    "LEFT JOIN LATERAL (",
    " SELECT COALESCE(m.source_created_at,m.created_at) AS latest_inbound_at",
    " FROM messages m WHERE m.contact_id=c.id AND m.role='user'",
    " ORDER BY COALESCE(m.source_created_at,m.created_at) DESC,m.id DESC LIMIT 1",
    ") inbound_source ON TRUE",
    "LEFT JOIN LATERAL (",
    " SELECT m.id,m.created_at FROM messages m",
    " WHERE m.contact_id=c.id AND m.role='user'",
    " ORDER BY m.created_at DESC,m.id DESC LIMIT 1",
    ") last_inbound ON TRUE",
    "LEFT JOIN LATERAL (",
    " SELECT outbound.id,outbound.created_at FROM messages outbound",
    " WHERE outbound.contact_id=c.id AND outbound.role='assistant'",
    " AND " + acceptedNormalOutboundSql("outbound"),
    " ORDER BY outbound.created_at DESC,outbound.id DESC LIMIT 1",
    ") accepted ON last_inbound.id IS NOT NULL",
    "WHERE (latest.created_at IS NOT NULL OR c.channel='whatsapp')",
    ...(hideEmpty ? [] : [scope]),
    "ORDER BY c.needs_attention DESC,latest.created_at DESC NULLS LAST,",
    " c.created_at DESC,c.id DESC",
  ].join("\n");
  const result = await pool.query(sql, params);
  if (wal && (await currentWal()) === wal) {
    cachedIndex = {
      wal, query: normalizedQuery, rows: result.rows,
      expiresAt: Date.now() + INDEX_CACHE_TTL_MS,
    };
  } else if (cacheable) {
    cachedIndex = null;
  }
  return result.rows;
}

module.exports = { listInboxPageIndex, resetIndexCacheForTests };
