const config = require("../config/clinicConfig");

const SCHEDULING_PATTERN =
  /(appointment|book(?:ing)?|slot|availability|available|date|time|branch|location|address|hours?|open|close|预约|预[订定]|时[间段]|几点|几时|分店|地点|地址|营业|开门|关门|temujanji|janji temu|slot|masa|pukul|cawangan|lokasi|alamat|buka|tutup)/iu;
const CONTACT_PATTERN =
  /(phone|contact|call|whatsapp|instagram|facebook|tiktok|号码|電話|电话|联系|聯絡|whatsapp|ig|fb|hubungi|telefon|nombor)/iu;
const PROMOTION_PATTERN =
  /(price|cost|fee|charge|package|promo|promotion|offer|discount|voucher|多少钱|多少錢|价格|價錢|价钱|配套|优惠|優惠|促销|促銷|berapa|harga|pakej|promosi|diskaun|baucar|tawaran)/iu;

function cleanText(value) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function messageText(message) {
  if (typeof message?.content === "string") return cleanText(message.content);
  if (!Array.isArray(message?.content)) return "";
  return cleanText(
    message.content
      .filter((part) => part?.type === "text" && typeof part?.text === "string")
      .map((part) => part.text)
      .join(" ")
  );
}

function normalizeComparable(value) {
  return cleanText(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function splitAliasTerms(value) {
  const raw = cleanText(value);
  if (!raw) return [];
  const parts = raw
    .split(/\s*(?:\/|\||,|;|，|、|｜)\s*/u)
    .map(cleanText)
    .filter(Boolean);
  return [...new Set([raw, ...parts])];
}

function usefulTerm(value) {
  const key = normalizeComparable(value);
  if (!key || key.length < 2) return null;
  if (!/^[a-z0-9]+$/u.test(key)) return { value: cleanText(value), key };
  if (key.length >= 3) return { value: cleanText(value), key };
  if (/[a-z]/u.test(key) && /[0-9]/u.test(key)) {
    return { value: cleanText(value), key };
  }
  return null;
}

function serviceCandidates(services = config.services, aliases = config.serviceAliases) {
  const configuredServices = Array.isArray(services) ? services : [];
  const configuredAliases = Array.isArray(aliases) ? aliases : [];

  return configuredServices
    .map((service) => {
      const name = cleanText(service?.name);
      if (!name) return null;
      const canonicalKey = normalizeComparable(name);
      const aliasTerms = configuredAliases
        .filter(
          (alias) => normalizeComparable(alias?.officialService) === canonicalKey
        )
        .flatMap((alias) => splitAliasTerms(alias?.alias));

      const terms = [name, ...aliasTerms]
        .map(usefulTerm)
        .filter(Boolean);

      return { name, terms };
    })
    .filter(Boolean);
}

function findServicesInText(text, candidates) {
  const normalized = normalizeComparable(text);
  if (!normalized) return [];

  const matches = [];
  for (const candidate of candidates) {
    if (candidate.terms.some(({ key }) => normalized.includes(key))) {
      matches.push(candidate.name);
    }
  }
  return matches;
}

function latestCustomerMessages(messages, limit = 8) {
  return (Array.isArray(messages) ? messages : [])
    .filter(
      (message) =>
        message?.role === "user" &&
        messageText(message)
    )
    .slice(-Math.max(1, Number(limit) || 8));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildConversationPromptContext(
  messages,
  {
    services = config.services,
    aliases = config.serviceAliases,
    metaAdContext = null,
  } = {}
) {
  const candidates = serviceCandidates(services, aliases);
  const customerMessages = latestCustomerMessages(messages, 8);
  const currentCustomerText = messageText(customerMessages.at(-1));
  const currentMatches = unique(findServicesInText(currentCustomerText, candidates));

  let relevantServiceNames = currentMatches.length <= 2 ? currentMatches : [];
  let serviceSource = currentMatches.length > 2
    ? "multi_service_broad"
    : relevantServiceNames.length
      ? "current_customer"
      : null;

  if (!relevantServiceNames.length && currentMatches.length <= 2) {
    for (let index = customerMessages.length - 2; index >= 0; index -= 1) {
      const matches = unique(
        findServicesInText(messageText(customerMessages[index]), candidates)
      );
      if (!matches.length) continue;
      if (matches.length > 2) {
        serviceSource = "multi_service_broad";
        break;
      }
      relevantServiceNames = matches;
      serviceSource = "recent_customer";
      break;
    }
  }

  if (!relevantServiceNames.length && metaAdContext) {
    const adText = [
      cleanText(metaAdContext?.headline),
      cleanText(metaAdContext?.body),
    ]
      .filter(Boolean)
      .join(" ");
    const adMatches = unique(findServicesInText(adText, candidates));
    if (adMatches.length === 1) {
      relevantServiceNames = adMatches;
      serviceSource = "meta_ad";
    }
  }

  const recentCustomerText = customerMessages
    .slice(-3)
    .map((message) => messageText(message))
    .join("\n");

  return {
    relevantServiceNames,
    serviceSource,
    currentCustomerText,
    schedulingIntent: SCHEDULING_PATTERN.test(recentCustomerText),
    contactIntent: CONTACT_PATTERN.test(recentCustomerText),
    promotionIntent: PROMOTION_PATTERN.test(currentCustomerText),
  };
}

module.exports = {
  CONTACT_PATTERN,
  PROMOTION_PATTERN,
  SCHEDULING_PATTERN,
  buildConversationPromptContext,
  cleanText,
  findServicesInText,
  messageText,
  normalizeComparable,
  serviceCandidates,
  splitAliasTerms,
};
