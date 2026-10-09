"use strict";

// Conservative on purpose: a CTWA click, an enquiry or an ad's prefilled
// greeting is NOT consent. Only the exact text the person actually sent
// can provide evidence, and only if it affirmatively requests future offers.
// False negatives should be reviewed by staff, never silently opted in.
function normalize(value) {
  return String(value || "").normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedIdentity(value) {
  return normalize(value).toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(?:centre|center|sdn|bhd|limited|ltd)\b/gi, "")
    .replace(/\s+/g, " ").trim();
}

function businessIsNamed(text, businessName) {
  const name = normalizedIdentity(businessName);
  const message = normalizedIdentity(text);
  if (name.length < 5 || !message.includes(name)) return false;
  const position = message.indexOf(name);
  return (position === 0 || message[position - 1] === " ") &&
    (position + name.length === message.length || message[position + name.length] === " ");
}

function explicitPromotionConsent(message, { businessName } = {}) {
  if (typeof message !== "string" || message.length > 2000) return null;
  const raw = normalize(message);
  const text = raw.toLowerCase();
  if (!raw || !businessIsNamed(raw, businessName)) return null;
  // Reject an otherwise matching message if it contains a refusal or an
  // opt-out. Never infer renewed consent from a later ordinary enquiry.
  if (/(?:不同意|不愿意|不想|不需要|不要|别(?:发|通知)|拒绝|取消订阅|stop\s+promotions?|do\s+not|don't|not\s+interested|unsubscribe|tak\s+nak|tidak\s+mahu|jangan|\b(?:another|other)\s+(?:clinic|business|provider)\b|(?:其他|别的|別的).{0,8}(?:诊所|診所|商家))/i.test(text)) return null;
  const chineseOffer = /(?:优惠|優惠|促销|促銷|推广|推廣|活动优惠)/.test(text);
  const englishOffer = /\b(?:offers?|promotions?|promos?|deals?)\b/i.test(text);
  const malayOffer = /\b(?:promosi|tawaran)\b/i.test(text);
  const mentionsWhatsApp = /whats\s*app/i.test(text);
  // A clear, affirmative wish to receive or be notified of ongoing offers.
  const zhPermission =
    (/(?:愿意|願意|同意|希望|想要|可以).{0,55}(?:收到|接收|收取|通知我|发我|發我|跟进我|跟進我)/.test(text) ||
      /(?:优惠|優惠|促销|促銷|推广|推廣).{0,22}(?:可以|请|請).{0,25}(?:通知我|发我|發我)/.test(text)) &&
    chineseOffer && mentionsWhatsApp;
  const enPermission = /\b(?:i(?:'d| would)?\s+(?:also\s+)?(?:like|want|agree|consent)\s+to\s+(?:receive|get)|feel\s+free\s+to\s+(?:whatsapp|message)|you\s+can\s+(?:whatsapp|send)|please\s+(?:send|whatsapp)\s+me)\b/i.test(text) &&
    englishOffer && mentionsWhatsApp;
  const msPermission = /\b(?:saya\s+(?:juga\s+)?(?:bersetuju|setuju|nak\s+terima)|boleh\s+whatsapp\s+saya|sila\s+(?:whatsapp|hantar))\b/i.test(text) &&
    (malayOffer || englishOffer) && mentionsWhatsApp;
  if (!zhPermission && !enPermission && !msPermission) return null;
  return {
    category: "MARKETING",
    scope: "treatment_followups_and_related_offers",
    method: "customer_whatsapp_text",
  };
}

module.exports = { explicitPromotionConsent, businessIsNamed, normalizedIdentity };
