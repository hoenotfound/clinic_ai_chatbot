const { effectivePermissions } = require("./permissions");

function hasOwn(updates, key) {
  return Object.prototype.hasOwnProperty.call(updates || {}, key);
}

function proposedOwner(current, updates = {}) {
  return {
    ...current,
    role: hasOwn(updates, "role") ? updates.role : current?.role,
    permissions: hasOwn(updates, "permissions") ? updates.permissions : current?.permissions,
    is_active: hasOwn(updates, "isActive") ? updates.isActive : current?.is_active,
  };
}

function canContinueServingOwnedLeads(user) {
  if (!user || user.is_active === false) return false;
  const permissions = effectivePermissions(user);
  const canView =
    permissions.view_assigned_leads === true || permissions.view_all_leads === true;
  return canView && permissions.reply_to_assigned_leads === true;
}

function ownedLeadContinuityError(current, updates, openLeadCount) {
  const count = Number(openLeadCount) || 0;
  if (count <= 0) return null;

  const nextUser = proposedOwner(current, updates);
  if (canContinueServingOwnedLeads(nextUser)) return null;

  const leadLabel = count === 1 ? "lead" : "leads";
  return `Reassign ${count} open ${leadLabel} owned by ${current?.display_name || current?.username || "this account"} before disabling this account or removing its ability to view and reply to owned leads.`;
}

module.exports = {
  canContinueServingOwnedLeads,
  ownedLeadContinuityError,
  proposedOwner,
};
