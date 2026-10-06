const config = require("../config/clinicConfig");

const SCHEDULING_PATTERN =
  /(appointment|book(?:ing)?|slot|availability|available|date|time|branch|location|address|where|place|shop|clinic|centre|center|hours?|open|close|today|tomorrow|morning|afternoon|evening|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|预约|预[订定]|时[间段]|几点|几时|分店|分行|门店|門店|店在|店哪|哪里|哪裡|哪儿|哪兒|在哪|地点|地點|地址|营业|營業|开门|開門|关门|關門|今天|明天|后天|後天|星期[一二三四五六日天]|礼拜[一二三四五六日天]|禮拜[一二三四五六日天]|早上|上午|中午|下午|晚上|temujanji|janji temu|slot|masa|pukul|cawangan|lokasi|alamat|di mana|kat mana|tempat|buka|tutup|hari ini|esok|pagi|petang|malam|isnin|selasa|rabu|khamis|jumaat|sabtu|ahad)/iu;
const CONTACT_PATTERN =
  /(phone|contact|call|whatsapp|instagram|facebook|tiktok|号码|電話|电话|联系|聯絡|hubungi|telefon|nombor|\big\b|\bfb\b)/iu;
const PROMOTION_PATTERN =
  /(price|pricing|cost|fee|charge|rate|how\s+much|package|promo|promotion|offer|discount|voucher|多少钱|多少錢|价格|價格|價錢|价钱|价位|價位|费用|費用|收费|收費|几多|幾多|配套|优惠|優惠|促销|促銷|berapa|harga|pakej|promosi|diskaun|baucar|tawaran)/iu;
const BARE_AMOUNT_PATTERN = /(?:rm\s*)?\d{3,4}(?!\d)/iu;
const NON_TREATMENT_ANCHOR_PATTERN =
  /(assessment|consult(?:ation)?|evaluation|评估|評估|咨询|諮詢|面诊|面診)/iu;
const SERVICE_DISCOVERY_PATTERN =
  /(what|which|show|list|any).{0,30}(treatments|services|options)|(other|more).{0,20}(treatments?|services?|options?)|(treatments|services).{0,30}(do you have|available|offer)|还有什么.{0,12}(疗程|療程|服务|服務)|其他.{0,12}(疗程|療程|服务|服務)|有什么.{0,12}(疗程|療程|服务|服務)|有哪些.{0,12}(疗程|療程|服务|服務)|rawatan apa|rawatan lain|servis apa|servis lain/iu;

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

function compactServiceCodeTerms(value) {
  const raw = cleanText(value);
  if (!raw) return [];
  const matches = raw.match(/\b[a-z0-9]{2,8}\b/giu) || [];
  const mixed = matches.filter(
    (token) => /[a-z]/iu.test(token) && /[0-9]/u.test(token)
  );
  return mixed.length === 1 ? mixed : [];
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

      const terms = [
        name,
        ...aliasTerms,
        ...compactServiceCodeTerms(name),
      ]
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

function strongServiceMatchesInText(text, candidates) {
  const normalized = normalizeComparable(text);
  if (!normalized) return [];

  const matches = [];
  for (const candidate of candidates) {
    const canonicalKey = normalizeComparable(candidate.name);
    if (canonicalKey && normalized.includes(canonicalKey)) {
      matches.push(candidate.name);
      continue;
    }

    const hasStrongAlias = candidate.terms.some(({ key }) => {
      if (!normalized.includes(key)) return false;
      if (key.length >= 3) return true;
      return (
        /^[a-z0-9]+$/u.test(key) &&
        /[a-z]/u.test(key) &&
        /[0-9]/u.test(key)
      );
    });
    if (hasStrongAlias) matches.push(candidate.name);
  }
  return matches;
}


function recentConversationServiceAnchor(messages, candidates, maxMessages = 8) {
  const source = Array.isArray(messages) ? messages : [];
  let skippedCurrentCustomer = false;
  let inspected = 0;

  for (let index = source.length - 1; index >= 0; index -= 1) {
    const message = source[index];
    if (!["user", "assistant"].includes(message?.role)) continue;

    if (!skippedCurrentCustomer) {
      if (message.role === "user") {
        skippedCurrentCustomer = true;
      }
      continue;
    }

    inspected += 1;
    if (inspected > maxMessages) break;

    const matches = unique(findServicesInText(messageText(message), candidates));
    if (!matches.length) continue;

    if (message.role === "user") {
      if (matches.length > 2) {
        return { relevantServiceNames: [], serviceSource: "multi_service_broad" };
      }
      return {
        relevantServiceNames: matches,
        serviceSource: "recent_customer",
      };
    }

    if (/(package|套餐|配套|包含|includes?|options?|方案)/iu.test(messageText(message))) {
      continue;
    }

    const strongMatches = unique(
      strongServiceMatchesInText(messageText(message), candidates)
    );
    if (strongMatches.length === 1) {
      if (NON_TREATMENT_ANCHOR_PATTERN.test(strongMatches[0])) {
        continue;
      }

      let previousCustomerMatches = [];
      for (let previous = index - 1; previous >= 0; previous -= 1) {
        if (source[previous]?.role !== "user") continue;
        previousCustomerMatches = unique(
          findServicesInText(messageText(source[previous]), candidates)
        );
        break;
      }

      // An assistant may clarify an ambiguous customer phrase (for example,
      // "调整身体" -> 徒手体态调理). Use that as a short-lived anchor.
      // But never let an assistant-introduced service override a service the
      // customer explicitly named in the message being answered.
      if (!previousCustomerMatches.length) {
        return {
          relevantServiceNames: strongMatches,
          serviceSource: "recent_assistant",
        };
      }
      continue;
    }
    // Assistant replies that mention several strong services are usually
    // comparisons or menus. They are too ambiguous to choose one.
  }

  return null;
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
  const serviceDiscoveryIntent = SERVICE_DISCOVERY_PATTERN.test(currentCustomerText);

  let relevantServiceNames = serviceDiscoveryIntent
    ? []
    : currentMatches.length <= 2
      ? currentMatches
      : [];
  let serviceSource = serviceDiscoveryIntent
    ? "broad_discovery"
    : currentMatches.length > 2
      ? "multi_service_broad"
      : relevantServiceNames.length
        ? "current_customer"
        : null;

  if (
    !relevantServiceNames.length &&
    currentMatches.length <= 2 &&
    !serviceDiscoveryIntent
  ) {
    const recentAnchor = recentConversationServiceAnchor(messages, candidates);
    if (recentAnchor) {
      relevantServiceNames = recentAnchor.relevantServiceNames;
      serviceSource = recentAnchor.serviceSource;
    } else {
      // Preserve the original customer-only memory window as a fallback.
      // Assistant/result-media rows can be numerous, so an 8-message mixed
      // window must not make the selector forget a still-active customer topic.
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
  }

  if (!relevantServiceNames.length && !serviceSource && metaAdContext) {
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
    promotionIntent:
      PROMOTION_PATTERN.test(currentCustomerText) ||
      (currentCustomerText.length <= 24 && BARE_AMOUNT_PATTERN.test(currentCustomerText)),
    serviceDiscoveryIntent,
  };
}

module.exports = {
  BARE_AMOUNT_PATTERN,
  CONTACT_PATTERN,
  NON_TREATMENT_ANCHOR_PATTERN,
  PROMOTION_PATTERN,
  SCHEDULING_PATTERN,
  SERVICE_DISCOVERY_PATTERN,
  buildConversationPromptContext,
  cleanText,
  compactServiceCodeTerms,
  findServicesInText,
  messageText,
  normalizeComparable,
  recentConversationServiceAnchor,
  serviceCandidates,
  splitAliasTerms,
  strongServiceMatchesInText,
};
