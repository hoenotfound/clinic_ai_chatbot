const DEFAULT_RESULT_MEDIA_DUPLICATE_HOURS = 7 * 24;

function normalizeServiceName(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function matchingResultMediaSet(resultMedia, treatment) {
  const target = normalizeServiceName(treatment);
  if (!target || !Array.isArray(resultMedia)) return null;

  const matches = resultMedia.filter(
    (entry) =>
      entry &&
      entry.enabled === true &&
      entry.sendAfterPrice === true &&
      normalizeServiceName(entry.service) === target
  );
  if (matches.length !== 1) return null;

  const [entry] = matches;
  const items = (Array.isArray(entry.items) ? entry.items : []).filter(
    (item) =>
      item &&
      typeof item.imageUrl === "string" &&
      item.imageUrl.trim() &&
      typeof item.caption === "string" &&
      item.caption.trim()
  );
  if (!items.length) return null;

  const configuredCount = Number(entry.autoSendCount);
  const autoSendCount =
    Number.isSafeInteger(configuredCount) && configuredCount >= 1
      ? Math.min(configuredCount, 2, items.length)
      : 1;

  return {
    ...entry,
    service: String(entry.service || "").trim(),
    autoSendCount,
    items,
  };
}

/**
 * Chooses approved service-level result media after a successful price reply. Automatic proof is deliberately conservative: if any configured
 * result image for this service was already accepted for this contact inside
 * the duplicate window, do not send another automatic result example.
 */
async function resolveResultMediaForReply({
  priceQuery,
  packageQuery,
  treatment,
  flagged,
  bookingReady,
  keywordReason,
  needsAttention,
  textSendSucceeded,
  resultMedia,
  contactId,
  wasMediaRecentlySent,
  duplicateWindowHours = DEFAULT_RESULT_MEDIA_DUPLICATE_HOURS,
}) {
  if (
    priceQuery !== true ||
    !treatment ||
    flagged ||
    bookingReady ||
    keywordReason ||
    needsAttention ||
    textSendSucceeded !== true
  ) {
    return null;
  }

  const resultSet = matchingResultMediaSet(resultMedia, treatment);
  if (!resultSet) return null;

  if (typeof wasMediaRecentlySent !== "function" || !contactId) {
    return null;
  }

  for (const item of resultSet.items) {
    const recentlySent = await wasMediaRecentlySent(
      contactId,
      item.imageUrl,
      duplicateWindowHours
    );
    if (recentlySent) return null;
  }

  return {
    service: resultSet.service,
    items: resultSet.items.slice(0, resultSet.autoSendCount),
  };
}

module.exports = {
  DEFAULT_RESULT_MEDIA_DUPLICATE_HOURS,
  matchingResultMediaSet,
  resolveResultMediaForReply,
};
