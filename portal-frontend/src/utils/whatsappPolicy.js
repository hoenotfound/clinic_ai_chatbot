export const WHATSAPP_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const STANDARD_MESSAGING_WINDOW_MS = WHATSAPP_REPLY_WINDOW_MS;
export const HUMAN_AGENT_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const STANDARD_WINDOW_CHANNELS = new Set(["whatsapp", "facebook", "instagram"]);
const HUMAN_AGENT_CHANNELS = new Set(["facebook", "instagram"]);

const POLICY_COPY = {
  opted_out: {
    label: "Customer opted out of WhatsApp messages",
    explanation:
      "This customer has opted out. Normal replies and automated follow-ups cannot be sent unless they start a new support conversation.",
  },
  no_customer_message: {
    label: "Customer has not messaged the business yet",
    explanation:
      "The customer must message the business before a normal WhatsApp reply can be sent.",
  },
  outside_customer_service_window: {
    label: "Reply window closed",
    explanation:
      "The customer must message again before a normal WhatsApp reply can be sent.",
  },
  human_agent_only: {
    label: "Staff reply only",
    explanation:
      "Only a staff-written reply to the customer's inquiry can be sent now. AI replies, scheduled messages, and automated follow-ups remain blocked.",
  },
  outside_human_agent_window: {
    label: "Reply window closed",
    explanation:
      "The 7-day Human Agent window has closed. The customer must message again before staff can reply.",
  },
};

export function messagingChannelLabel(channel) {
  if (channel === "facebook") return "Facebook Messenger";
  if (channel === "instagram") return "Instagram";
  return "WhatsApp";
}

function policyExplanation(channel, code) {
  if (code === "no_customer_message") {
    if (channel === "facebook") {
      return "The customer must message the Page before a normal Messenger reply can be sent.";
    }
    if (channel === "instagram") {
      return "The customer must message the Instagram account before a normal reply can be sent.";
    }
  }
  if (code === "outside_customer_service_window" && channel !== "whatsapp") {
    return `The customer must message again before a normal ${messagingChannelLabel(channel)} reply can be sent.`;
  }
  return POLICY_COPY[code]?.explanation || null;
}

function timestamp(value) {
  if (!value) return null;
  const valueMs = new Date(value).getTime();
  return Number.isFinite(valueMs) ? valueMs : null;
}

export function formatReplyTimeRemaining(milliseconds) {
  const remainingMinutes = Math.max(0, Math.ceil(milliseconds / 60000));
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

export function messagingPolicyStatus(contact, now = Date.now()) {
  const channel = contact?.channel || "whatsapp";
  if (!STANDARD_WINDOW_CHANNELS.has(channel)) {
    return {
      applies: false,
      freeformAllowed: true,
      humanAgentAllowed: false,
      manualReplyAllowed: true,
      automatedAllowed: true,
      code: null,
      label: null,
      explanation: null,
      latestCustomerMessageAt: null,
      replyWindowExpiresAt: null,
      humanAgentWindowExpiresAt: null,
      optedOutAt: null,
      channel,
      channelLabel: messagingChannelLabel(channel),
    };
  }

  const currentMs = now instanceof Date ? now.getTime() : Number(now);
  const latestInboundValue =
    contact?.latest_inbound_at || contact?.latestInboundAt || contact?.latest_customer_message_at;
  const latestInboundMs = timestamp(latestInboundValue);
  const optOutValue = channel === "whatsapp"
    ? contact?.whatsapp_opt_out_at || contact?.whatsappOptOutAt
    : null;
  const optOutMs = timestamp(optOutValue);
  const marketingOptOutValue = channel === "whatsapp"
    ? contact?.whatsapp_marketing_opt_out_at || contact?.whatsappMarketingOptOutAt
    : null;
  const marketingOptOutMs = timestamp(marketingOptOutValue);
  const replyWindowExpiresMs = latestInboundMs == null
    ? null
    : latestInboundMs + WHATSAPP_REPLY_WINDOW_MS;
  const humanAgentFeatureEnabled =
    contact?.human_agent_enabled === true &&
    HUMAN_AGENT_CHANNELS.has(channel);
  const humanAgentWindowExpiresMs =
    latestInboundMs != null && humanAgentFeatureEnabled
      ? latestInboundMs + HUMAN_AGENT_REPLY_WINDOW_MS
      : null;
  const customerReinitiatedAfterOptOut =
    optOutMs != null && latestInboundMs != null && latestInboundMs > optOutMs;

  let code = null;
  if (optOutMs != null && !customerReinitiatedAfterOptOut) {
    code = "opted_out";
  } else if (latestInboundMs == null) {
    code = "no_customer_message";
  } else if (!Number.isFinite(currentMs)) {
    code = "outside_customer_service_window";
  } else if (
    humanAgentWindowExpiresMs != null &&
    currentMs >= humanAgentWindowExpiresMs
  ) {
    code = "outside_human_agent_window";
  } else if (currentMs >= replyWindowExpiresMs) {
    code = humanAgentFeatureEnabled
      ? "human_agent_only"
      : "outside_customer_service_window";
  }

  const freeformAllowed = code == null;
  const humanAgentAllowed = code === "human_agent_only";
  const manualReplyAllowed = freeformAllowed || humanAgentAllowed;
  const remainingMs = freeformAllowed ? replyWindowExpiresMs - currentMs : 0;
  const humanAgentRemainingMs = humanAgentAllowed
    ? humanAgentWindowExpiresMs - currentMs
    : 0;

  return {
    applies: true,
    freeformAllowed,
    humanAgentAllowed,
    manualReplyAllowed,
    automatedAllowed: freeformAllowed && optOutMs == null,
    code,
    label: freeformAllowed
      ? `Reply available · ${formatReplyTimeRemaining(remainingMs)} remaining`
      : humanAgentAllowed
        ? `Staff reply only · ${formatReplyTimeRemaining(humanAgentRemainingMs)} remaining`
        : POLICY_COPY[code].label,
    explanation: freeformAllowed ? null : policyExplanation(channel, code),
    channel,
    channelLabel: messagingChannelLabel(channel),
    latestCustomerMessageAt: latestInboundValue || null,
    replyWindowExpiresAt: replyWindowExpiresMs == null
      ? null
      : new Date(replyWindowExpiresMs).toISOString(),
    humanAgentWindowExpiresAt: humanAgentWindowExpiresMs == null
      ? null
      : new Date(humanAgentWindowExpiresMs).toISOString(),
    humanAgentFeatureEnabled,
    optedOutAt: optOutValue || null,
    marketingOptedOutAt: marketingOptOutValue || null,
    marketingOptedOut: marketingOptOutMs != null,
    customerReinitiatedAfterOptOut,
  };
}

// Keep the existing export while callers migrate to the channel-neutral name.
export const whatsappPolicyStatus = messagingPolicyStatus;

export function policyFailureCodeFromMessage(message) {
  if (message?.policy_code && POLICY_COPY[message.policy_code]) {
    return message.policy_code;
  }

  const error = String(message?.delivery_error || "").toLowerCase();
  if (/opted out|opt-out/.test(error)) return "opted_out";
  if (/never messaged|has not sent a message|hasn't sent a message/.test(error)) {
    return "no_customer_message";
  }
  if (/7-day.*human agent.*closed|human agent window.*closed/.test(error)) {
    return "outside_human_agent_window";
  }
  if (/24-hour.*window.*closed|customer-service.*window.*closed|outside.*reply window/.test(error)) {
    return "outside_customer_service_window";
  }
  return null;
}

export function policyFailureExplanation(message, channel = "whatsapp") {
  const code = policyFailureCodeFromMessage(message);
  return code ? policyExplanation(channel, code) : null;
}
