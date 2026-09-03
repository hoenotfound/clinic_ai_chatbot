export const WHATSAPP_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

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
};

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

export function whatsappPolicyStatus(contact, now = Date.now()) {
  const channel = contact?.channel || "whatsapp";
  if (channel !== "whatsapp") {
    return {
      applies: false,
      freeformAllowed: true,
      automatedAllowed: true,
      code: null,
      label: null,
      explanation: null,
      latestCustomerMessageAt: null,
      replyWindowExpiresAt: null,
      optedOutAt: null,
    };
  }

  const currentMs = now instanceof Date ? now.getTime() : Number(now);
  const latestInboundValue =
    contact?.latest_inbound_at || contact?.latestInboundAt || contact?.latest_customer_message_at;
  const latestInboundMs = timestamp(latestInboundValue);
  const optOutValue = contact?.whatsapp_opt_out_at || contact?.whatsappOptOutAt;
  const optOutMs = timestamp(optOutValue);
  const replyWindowExpiresMs = latestInboundMs == null
    ? null
    : latestInboundMs + WHATSAPP_REPLY_WINDOW_MS;
  const customerReinitiatedAfterOptOut =
    optOutMs != null && latestInboundMs != null && latestInboundMs > optOutMs;

  let code = null;
  if (optOutMs != null && !customerReinitiatedAfterOptOut) {
    code = "opted_out";
  } else if (latestInboundMs == null) {
    code = "no_customer_message";
  } else if (!Number.isFinite(currentMs) || currentMs >= replyWindowExpiresMs) {
    code = "outside_customer_service_window";
  }

  const freeformAllowed = code == null;
  const remainingMs = freeformAllowed ? replyWindowExpiresMs - currentMs : 0;
  return {
    applies: true,
    freeformAllowed,
    automatedAllowed: freeformAllowed && optOutMs == null,
    code,
    label: freeformAllowed
      ? `Reply available · ${formatReplyTimeRemaining(remainingMs)} remaining`
      : POLICY_COPY[code].label,
    explanation: freeformAllowed ? null : POLICY_COPY[code].explanation,
    latestCustomerMessageAt: latestInboundValue || null,
    replyWindowExpiresAt: replyWindowExpiresMs == null
      ? null
      : new Date(replyWindowExpiresMs).toISOString(),
    optedOutAt: optOutValue || null,
    customerReinitiatedAfterOptOut,
  };
}

export function policyFailureCodeFromMessage(message) {
  if (message?.policy_code && POLICY_COPY[message.policy_code]) {
    return message.policy_code;
  }

  const error = String(message?.delivery_error || "").toLowerCase();
  if (/opted out|opt-out/.test(error)) return "opted_out";
  if (/never messaged|has not sent a message|hasn't sent a message/.test(error)) {
    return "no_customer_message";
  }
  if (/24-hour.*window.*closed|customer-service.*window.*closed|outside.*reply window/.test(error)) {
    return "outside_customer_service_window";
  }
  return null;
}

export function policyFailureExplanation(message) {
  const code = policyFailureCodeFromMessage(message);
  return code ? POLICY_COPY[code].explanation : null;
}
