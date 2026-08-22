/**
 * Picks which promotion (if any) should be sent as the first-reply promo image.
 *
 * Deliberately a pure function, separate from clinicConfig and server.js, so
 * the date logic is independently testable and never trusted to the AI —
 * same reliability pattern as the isFirstMessage check in server.js. Sending
 * an EXPIRED promo would directly violate the "never invent/reference fake
 * urgency" guardrail already in clinicConfig.js, so this check has to be a
 * hard code guarantee, not a prompt instruction.
 *
 * @param {Array<{name, imageUrl, caption, validFrom, validUntil}>} promotions
 * @param {Date} [now] - injectable for testing; defaults to current time
 * @returns {{name, imageUrl, caption, validFrom, validUntil} | null}
 */
function getActivePromotion(promotions, now = new Date()) {
  if (!Array.isArray(promotions) || promotions.length === 0) return null;

  const active = promotions.filter((p) => {
    if (!p.imageUrl) return false; // no image configured yet — skip, don't send a broken link
    const from = p.validFrom ? new Date(p.validFrom) : null;
    const until = p.validUntil ? new Date(p.validUntil) : null;
    if (from && now < from) return false;
    if (until && now > until) return false;
    return true;
  });

  if (active.length === 0) return null;

  // If multiple are active, just take the first one listed — keep it simple,
  // sending more than one image on a first reply is unnecessary/spammy.
  return active[0];
}

module.exports = { getActivePromotion };
