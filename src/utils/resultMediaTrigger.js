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
 * Chooses approved service-level result media after a successful price reply.
 * Automatic proof is deliberately conservative: if any configured result image
 * for this service was accepted inside the duplicate window, do not send more.
 * Once the cooldown expires, continue with the example after the most recently
 * accepted one so larger result libraries actually rotate.
 */
function mediaIdentity(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const match = raw.match(
    /\/(?:promo-images|api\/config\/result-media\/image)\/(\d+)(?:[/?#]|$)/
  );
  return match ? `stored:${match[1]}` : raw;
}

function rotateAfter(items, lastImageUrl) {
  if (!Array.isArray(items) || items.length === 0 || !lastImageUrl) return items;
  const lastIdentity = mediaIdentity(lastImageUrl);
  const index = items.findIndex(
    (item) => mediaIdentity(item.imageUrl) === lastIdentity
  );
  if (index < 0) return items;
  const start = (index + 1) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

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
  getMostRecentlySentMediaUrl,
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

  if (
    typeof wasMediaRecentlySent !== "function" ||
    typeof getMostRecentlySentMediaUrl !== "function" ||
    !contactId
  ) {
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

  const lastImageUrl = await getMostRecentlySentMediaUrl(
    contactId,
    resultSet.items.map((item) => item.imageUrl)
  );
  const rotatedItems = rotateAfter(resultSet.items, lastImageUrl);

  return {
    service: resultSet.service,
    items: rotatedItems.slice(0, resultSet.autoSendCount),
  };
}

module.exports = {
  DEFAULT_RESULT_MEDIA_DUPLICATE_HOURS,
  matchingResultMediaSet,
  mediaIdentity,
  rotateAfter,
  resolveResultMediaForReply,
};
