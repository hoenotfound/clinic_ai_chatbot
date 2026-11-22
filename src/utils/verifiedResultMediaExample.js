"use strict";

// Verified visual-result context is derived ONLY from an approved configured
// result-media item that matches a recent, already-sent assistant caption.
// Customers, ad copy and unrelated assistant statements cannot assert that
// a picture represents exactly one session.
const SESSION_RESULT_QUESTION =
  /(?:一次|一回|第一[次回]|單次|单次|1\s*(?:次|回|session)|one\s+session|single\s+session|first\s+session|效果|見效|见效|有分别|有分別|results?\s+after|noticeable\s+change)/iu;

function normalized(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function authorizedCaptions(item) {
  const captions = [item?.caption];
  for (const lang of ["zh", "en", "ms"]) {
    captions.push(item?.mediaTranslations?.[lang]?.caption);
  }
  return new Set(captions.map(normalized).filter(Boolean));
}

function safeImageIdentity(url) {
  const value = String(url || "").trim();
  // The image path is first-party provider data, not a user-controlled query.
  const id = value.match(/\/(?:promo-images|api\/config\/result-media\/image)\/([1-9]\d{0,9})(?:[/?#]|$)/u);
  return id ? "media:" + id[1] : value;
}

function authorizedImages(item) {
  const urls = [item?.imageUrl];
  for (const language of ["zh", "en", "ms"]) {
    urls.push(item?.mediaTranslations?.[language]?.imageUrl);
  }
  return new Set(urls.map(safeImageIdentity).filter(Boolean));
}

function verifiedResultExampleForConversation({
  messages, resultMedia = [], serviceName = "", customerText = "",
} = {}) {
  const question = String(customerText || "");
  const mentionsSessionCount =
    /(?:一次|一回|第一[次回]|單次|单次|1\s*(?:次|回|session)|one\s+session|single\s+session|first\s+session)/iu.test(question);
  const asksAboutResult =
    /(?:效果|見效|见效|有分别|有分別|变化|變化|这样|這樣|results?|difference|change|improvement|noticeable|after)/iu.test(question);
  const isMonetaryQuestion =
    /(?:多少钱|多少錢|价格|價格|价钱|價錢|收费|收費|费用|費用|多少RM|\b(?:price|how much|cost|fee|harga)\b)/iu.test(question);
  if (!SESSION_RESULT_QUESTION.test(question) || !mentionsSessionCount ||
      !asksAboutResult || isMonetaryQuestion) return null;
  const service = normalized(serviceName);
  if (!Array.isArray(messages) || !messages.length) return null;
  const groups = (Array.isArray(resultMedia) ? resultMedia : [])
    .filter(group => group?.enabled === true &&
      (!service || normalized(group.service) === service));
  if (!groups.length) return null;
  const allItems = groups.flatMap(group =>
    (Array.isArray(group.items) ? group.items : [])
      .filter(item => typeof item?.caption === "string" && item.caption.trim())
      .map(item => ({ item, service: group.service })));
  if (!allItems.length) return null;

  const lastCustomer = messages.findLastIndex(message => message?.role === "user");
  if (lastCustomer < 1) return null;
  // A short immediate follow-up can refer to an image a few message turns ago.
  // Stop at the most recent matching approved image; an unverified newer image
  // must never borrow verified metadata from an earlier one.
  for (let i = lastCustomer - 1; i >= Math.max(0, lastCustomer - 8); i -= 1) {
    if (messages[i]?.role !== "assistant" ||
        typeof messages[i]?.content !== "string") continue;
    const caption = normalized(messages[i].content);
    const matched = allItems.filter(row => authorizedCaptions(row.item).has(caption));
    if (matched.length !== 1) continue;
    const savedPhoto = safeImageIdentity(messages[i].verifiedOutboundImageUrl);
    // Never authorize the claim using a copied caption without the actual
    // outbound image matching this exact approved configured item.
    if (!savedPhoto || !authorizedImages(matched[0].item).has(savedPhoto)) return null;
    const verifiedPhoto = safeImageIdentity(matched[0].item.verifiedSessionImageUrl);
    if (!verifiedPhoto || verifiedPhoto !== savedPhoto ||
        verifiedPhoto !== safeImageIdentity(matched[0].item.imageUrl)) return null;
    return matched[0].item.verifiedSessionCount === 1
      ? { service: matched[0].service, verifiedSessionCount: 1 }
      : null;
  }
  return null;
}

module.exports = { verifiedResultExampleForConversation, SESSION_RESULT_QUESTION };
