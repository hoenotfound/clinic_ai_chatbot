"use strict";

// Narrow discovery only. The original sender, consent, billing and final
// pre-send checks remain in the same SQL. Never interpolate contact IDs.
function scopeSecondaryRead(sql, params, contactIds) {
  if (contactIds == null) return [sql, params];
  if (!Array.isArray(contactIds) || contactIds.length === 0 || contactIds.length > 100 ||
      contactIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new TypeError("Invalid secondary contact scope");
  }
  const ids = [...new Set(contactIds)];
  const binding = `$${params.length + 1}::bigint[]`;
  const markers = [
    ["WHERE recent.created_at >", `WHERE recent.contact_id = ANY(${binding}) AND recent.created_at >`],
    ["WHERE e.consent_scope=", `WHERE e.contact_id = ANY(${binding}) AND e.consent_scope=`],
  ];
  const match = markers.find(([marker]) => sql.includes(marker));
  if (!match) throw new Error("Secondary discovery query has no known contact shortlist");
  return [sql.replace(match[0], match[1]), [...params, ids]];
}

module.exports = { scopeSecondaryRead };
