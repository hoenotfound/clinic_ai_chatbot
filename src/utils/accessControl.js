const { pool } = require("../db/db");
const { hasCapability } = require("./permissions");

function canViewAssigned(user) {
  return hasCapability(user, "view_assigned_leads");
}

function canViewAll(user) {
  return hasCapability(user, "view_all_leads");
}

function canManageAnyLead(user) {
  return hasCapability(user, "manage_lead_assignment");
}

async function getCurrentLeadAccessForContact(contactId, queryable = pool) {
  const result = await queryable.query(
    `SELECT id, contact_id, owner_username
     FROM leads
     WHERE contact_id = $1
     ORDER BY is_closed ASC, created_at DESC, id DESC
     LIMIT 1`,
    [contactId]
  );
  return result.rows[0] || null;
}

async function canAccessContact(user, contactId) {
  if (canViewAll(user)) return true;
  if (!canViewAssigned(user)) return false;
  const lead = await getCurrentLeadAccessForContact(contactId);
  return lead?.owner_username === user.username;
}

async function canAccessLead(user, leadId) {
  if (canViewAll(user)) return true;
  if (!canViewAssigned(user)) return false;
  const result = await pool.query(
    "SELECT owner_username FROM leads WHERE id = $1",
    [leadId]
  );
  return result.rows[0]?.owner_username === user.username;
}

/**
 * Viewing and acting are intentionally separate scopes. Sales users can see the
 * clinic-wide Inbox/Pipeline by default, but ordinary reply/manage capabilities
 * still apply only to their assigned leads. Users with Assign Leads permission
 * keep clinic-wide action authority because reassignment/admin workflows need it.
 */
async function canActOnContact(user, contactId) {
  if (canManageAnyLead(user)) return true;
  if (!hasCapability(user, "view_assigned_leads")) return false;
  const lead = await getCurrentLeadAccessForContact(contactId);
  return lead?.owner_username === user.username;
}

async function canActOnLead(user, leadId) {
  if (canManageAnyLead(user)) return true;
  if (!hasCapability(user, "view_assigned_leads")) return false;
  const result = await pool.query(
    "SELECT owner_username FROM leads WHERE id = $1",
    [leadId]
  );
  return result.rows[0]?.owner_username === user.username;
}

async function getAccessibleContactIds(user) {
  if (canViewAll(user)) return null;
  if (!canViewAssigned(user)) return [];

  const result = await pool.query(
    `WITH current_lead AS (
       SELECT DISTINCT ON (contact_id)
         id, contact_id, owner_username
       FROM leads
       ORDER BY contact_id, is_closed ASC, created_at DESC, id DESC
     )
     SELECT contact_id
     FROM current_lead
     WHERE owner_username = $1`,
    [user.username]
  );
  return result.rows.map((row) => Number(row.contact_id));
}

async function getAccessibleLeadIds(user) {
  if (canViewAll(user)) return null;
  if (!canViewAssigned(user)) return [];
  const result = await pool.query(
    "SELECT id FROM leads WHERE owner_username = $1",
    [user.username]
  );
  return result.rows.map((row) => Number(row.id));
}

function filterRowsByAccessibleContacts(rows, accessibleContactIds, key = "contact_id") {
  if (accessibleContactIds === null) return rows;
  const allowed = new Set(accessibleContactIds.map(Number));
  return (rows || []).filter((row) => allowed.has(Number(row?.[key])));
}

function filterLeadsForUser(leads, user) {
  if (canViewAll(user)) return leads || [];
  if (!canViewAssigned(user)) return [];
  return (leads || []).filter((lead) => lead.owner_username === user.username);
}

module.exports = {
  canAccessContact,
  canAccessLead,
  canActOnContact,
  canActOnLead,
  canManageAnyLead,
  canViewAll,
  canViewAssigned,
  filterLeadsForUser,
  filterRowsByAccessibleContacts,
  getAccessibleContactIds,
  getAccessibleLeadIds,
};
