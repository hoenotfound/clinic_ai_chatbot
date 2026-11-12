/**
 * Compare only the identity and control state of a conversation, not updated_at:
 * unread flags and normal messages can change updated_at without transferring
 * ownership. Used before social staff video sends to prevent late takeovers.
 */
function sameStaffVideoOwner(initial, current) {
  if (!initial?.id || !current?.id || Number(initial.id) !== Number(current.id)) return false;
  if (String(initial.channel || "whatsapp") !== String(current.channel || "whatsapp")) return false;
  if (String(initial.channel_user_id || "") !== String(current.channel_user_id || "")) return false;
  if (String(initial.mode || "ai") !== String(current.mode || "ai")) return false;
  if (String(initial.takeover_by || "") !== String(current.takeover_by || "")) return false;

  const takeoverTime = (contact) => {
    if (!contact.takeover_at) return null;
    const value = new Date(contact.takeover_at).getTime();
    return Number.isFinite(value) ? value : NaN;
  };
  const before = takeoverTime(initial);
  const after = takeoverTime(current);
  return before === after || (before === null && after === null);
}

module.exports = { sameStaffVideoOwner };
