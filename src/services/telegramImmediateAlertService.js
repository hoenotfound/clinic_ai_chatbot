const crypto = require("crypto");
const telegramImmediateAlertRepo = require("../db/telegramImmediateAlertRepo");
const clinicConfig = require("../config/clinicConfig");
const { getConversionProfile } = require("../config/conversionProfiles");
const { getOperationalLabels } = require("../utils/businessTerminology");
const { createAdaptiveWorkerTimer } = require("../utils/adaptiveWorkerTimer");
const {
  channelLabel,
  formatContactIdentifier,
  isTelegramEnabled,
  postTelegramMessage,
  temperatureLabel,
} = require("./telegramAlertService");
const { pool } = require("../db/db");

const IMMEDIATE_MESSAGE_LIMIT = 4000;
const LATEST_MESSAGE_LIMIT = 600;
const HUMAN_ALERT_COOLDOWN_MINUTES = 30;
const IMMEDIATE_ALERT_RETRY_DELAYS_MS = Object.freeze([
  60 * 1000,
  2 * 60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
]);
const IMMEDIATE_ALERT_WORKER_ERROR_RETRY_MS = 60 * 1000;

let immediateAlertWorker = null;

function clean(value, fallback = "Not captured") {
  const text = String(value || "").trim();
  return text || fallback;
}

function buildInboxUrl(contactId, env = process.env) {
  const baseUrl = String(env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  if (!baseUrl || !contactId) return null;
  return `${baseUrl}/inbox?contact=${encodeURIComponent(contactId)}`;
}

async function getImmediateAlertContext(contactId, query = pool.query.bind(pool)) {
  const result = await query(
    `SELECT
       c.id AS contact_id, c.whatsapp_number, c.name, c.whatsapp_profile_name,
       c.channel, c.channel_user_id,
       l.id AS lead_id, l.temperature, l.treatment_interest, l.branch_name,
       s.name AS stage_name,
       latest.id AS latest_customer_message_id,
       latest.content AS latest_customer_message
     FROM contacts c
     LEFT JOIN LATERAL (
       SELECT * FROM leads
       WHERE contact_id = c.id AND is_closed = false
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ) l ON true
     LEFT JOIN pipeline_stages s ON s.id = l.stage_id
     LEFT JOIN LATERAL (
       SELECT id, content FROM messages
       WHERE contact_id = c.id AND role = 'user'
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ) latest ON true
     WHERE c.id = $1`,
    [contactId]
  );
  return result.rows[0] || null;
}

function humanInterventionEventKey(context, reason, messageId = null) {
  // Automated paths tied to an inbound message use a stable key, preserving
  // exact-message dedupe in addition to the wider per-conversation cooldown.
  if (String(reason || "").trim() === "Flagged by staff.") return null;
  const capturedMessageId = Number(messageId || context.latest_customer_message_id);
  if (!Number.isSafeInteger(capturedMessageId) || capturedMessageId < 1) return null;
  return `human:${context.contact_id}:${capturedMessageId}`;
}

function bookingReadyEventKey(context, messageId = null) {
  const capturedMessageId = Number(messageId || context.latest_customer_message_id);
  if (!Number.isSafeInteger(capturedMessageId) || capturedMessageId < 1) return null;
  return `booking-ready:${context.contact_id}:${capturedMessageId}`;
}

function deliveryFailureEventKey(contactId) {
  return `delivery:${contactId}:event:${crypto.randomUUID()}`;
}

function nextStepLabel(value) {
  if (value === "site_visit") return "Site visit";
  if (value === "quotation_discussion") return "Quotation discussion";
  return clean(value);
}

function buildImmediateAlertMessage({
  type,
  context,
  reason,
  details = {},
  env = process.env,
  config = clinicConfig,
}) {
  const isDelivery = type === "delivery_failure";
  const isBookingReady = type === "booking_ready";
  const conversion = getConversionProfile(config);
  const labels = getOperationalLabels(config);
  const platform = channelLabel(context.channel || "whatsapp");
  const title = isDelivery
    ? `⚠️ ${platform} Delivery Failed`
    : isBookingReady
      ? conversion.alertTitle
      : "🚨 Human Intervention Required";
  const name = clean(context.name || context.whatsapp_profile_name, "Unknown contact");
  const lines = [
    title,
    "",
    `${name} (${formatContactIdentifier(context)})`,
    "",
    `Reason: ${clean(reason)}`,
    `Temperature: ${temperatureLabel(context.temperature)}`,
    `Stage: ${clean(context.stage_name)}`,
  ];

  if (isBookingReady && conversion.mode === "project") {
    lines.push(
      `Service: ${clean(context.treatment_interest)}`,
      `Project location: ${clean(details.projectLocation)}`,
      `Project: ${clean(details.projectSummary)}`,
      `Requested next step: ${nextStepLabel(details.nextStep)}`
    );
    if (details.appointmentPreference) {
      lines.push(`Preferred timing: ${clean(details.appointmentPreference)}`);
    }
    if (context.branch_name) {
      lines.push(`Business location: ${clean(context.branch_name)}`);
    }
  } else {
    lines.push(
      `${labels.serviceInterestLabel}: ${clean(context.treatment_interest)}`,
      `${labels.locationLabel}: ${clean(context.branch_name)}`
    );
  }

  if (context.latest_customer_message) {
    lines.push(
      "",
      `Latest ${labels.customerLabel} Message:`,
      clean(context.latest_customer_message).slice(0, LATEST_MESSAGE_LIMIT)
    );
  }

  const action = isDelivery
    ? `Action: Check the failed message in Inbox and retry or contact the ${labels.customerSingular} manually.`
    : isBookingReady
      ? `Action: ${conversion.alertAction}`
      : "Action: Open the conversation and review/respond as soon as possible.";
  lines.push("", action);

  const inboxUrl = buildInboxUrl(context.contact_id, env);
  if (inboxUrl) lines.push("", `Inbox: ${inboxUrl}`);

  const message = lines.join("\n");
  return message.length <= IMMEDIATE_MESSAGE_LIMIT
    ? message
    : `${message.slice(0, IMMEDIATE_MESSAGE_LIMIT - 3)}...`;
}

function retryDelayMsForAttempt(attempts) {
  const attempt = Math.max(1, Number(attempts) || 1);
  return IMMEDIATE_ALERT_RETRY_DELAYS_MS[
    Math.min(attempt - 1, IMMEDIATE_ALERT_RETRY_DELAYS_MS.length - 1)
  ];
}

function delayUntilNextImmediateAlert(result) {
  if (!result?.nextDueAt) return null;
  const timestamp = Date.parse(result.nextDueAt);
  if (Number.isNaN(timestamp)) return IMMEDIATE_ALERT_WORKER_ERROR_RETRY_MS;
  return Math.max(1000, timestamp - Date.now());
}

function createImmediateAlertQueueRunner({
  env = process.env,
  repository = telegramImmediateAlertRepo,
  sendMessage = postTelegramMessage,
  logger = console,
} = {}) {
  let running = false;

  return async function runImmediateAlertQueue() {
    if (running || !isTelegramEnabled(env)) {
      return { claimedCount: 0, sentCount: 0, failedCount: 0, nextDueAt: null };
    }

    running = true;
    let sentCount = 0;
    let failedCount = 0;

    try {
      await repository.markExhaustedStale();
      const alerts = await repository.claimReady();

      for (const alert of alerts) {
        try {
          await sendMessage({
            token: env.TELEGRAM_BOT_TOKEN,
            chatId: env.TELEGRAM_CHAT_ID,
            text: alert.message_text,
          });
          await repository.markSent(alert.id, alert.lease_token);
          sentCount += 1;
        } catch (err) {
          failedCount += 1;
          const retryDelaySeconds = Math.ceil(
            retryDelayMsForAttempt(alert.attempts) / 1000
          );
          await repository.markFailed(
            alert.id,
            alert.lease_token,
            err,
            { retryDelaySeconds }
          );
          logger.error(
            `Telegram immediate alert failed for contact ${alert.contact_id} (${alert.alert_type}); queued for retry:`,
            err
          );
        }
      }

      const nextDueAt = await repository.findNextDueAt();
      return {
        claimedCount: alerts.length,
        sentCount,
        failedCount,
        nextDueAt,
      };
    } finally {
      running = false;
    }
  };
}

function wakeImmediateAlertQueue(delayMs = 0) {
  return immediateAlertWorker?.wake(delayMs) || false;
}

const runImmediateAlertQueue = createImmediateAlertQueueRunner();

function startTelegramImmediateAlertRecovery() {
  if (!isTelegramEnabled()) return () => {};
  if (immediateAlertWorker && !immediateAlertWorker.state().stopped) {
    return () => immediateAlertWorker.stop();
  }

  immediateAlertWorker = createAdaptiveWorkerTimer({
    run: runImmediateAlertQueue,
    delayForResult: delayUntilNextImmediateAlert,
    errorRetryDelayMs: IMMEDIATE_ALERT_WORKER_ERROR_RETRY_MS,
    label: "Telegram immediate alert worker",
  });
  return immediateAlertWorker.start();
}

function createTelegramImmediateAlertService({
  env = process.env,
  getContext = getImmediateAlertContext,
  repository = telegramImmediateAlertRepo,
  wakeQueue = wakeImmediateAlertQueue,
  config = clinicConfig,
} = {}) {
  async function queuePreparedAlert({
    eventKey,
    type,
    contactId,
    messageText,
    cooldownMinutes = 0,
  }) {
    if (!isTelegramEnabled(env)) return { status: "disabled" };

    const queued = await repository.queueAlert({
      eventKey,
      type,
      contactId,
      messageText,
      cooldownMinutes,
    });
    if (!queued) return { status: "suppressed" };

    wakeQueue(0);
    return { status: "queued", alertId: queued.id };
  }

  async function queue(type, {
    contactId,
    reason,
    messageId = null,
    details = {},
  }) {
    if (!isTelegramEnabled(env)) return { status: "disabled" };

    const context = await getContext(contactId);
    if (!context) return { status: "skipped", reason: "contact-not-found" };

    let eventKey;
    let cooldownMinutes = 0;

    if (type === "human_intervention") {
      eventKey = humanInterventionEventKey(context, reason, messageId);
      if (!eventKey) {
        eventKey = `human:${contactId}:event:${crypto.randomUUID()}`;
      }
      cooldownMinutes = HUMAN_ALERT_COOLDOWN_MINUTES;
    } else if (type === "booking_ready") {
      eventKey = bookingReadyEventKey(context, messageId);
      if (!eventKey) {
        eventKey = `booking-ready:${contactId}:event:${crypto.randomUUID()}`;
      }
    } else {
      eventKey = deliveryFailureEventKey(contactId);
    }

    const messageText = buildImmediateAlertMessage({
      type,
      context,
      reason,
      details,
      env,
      config,
    });

    return queuePreparedAlert({
      eventKey,
      type,
      contactId,
      messageText,
      cooldownMinutes,
    });
  }

  return {
    queuePreparedAlert,
    sendHumanInterventionAlert(input) {
      return queue("human_intervention", input);
    },
    sendDeliveryFailureAlert(input) {
      return queue("delivery_failure", input);
    },
    sendBookingReadyAlert(input) {
      return queue("booking_ready", input);
    },
  };
}

const defaultService = createTelegramImmediateAlertService();

module.exports = {
  HUMAN_ALERT_COOLDOWN_MINUTES,
  HUMAN_ALERT_LOCK_NAMESPACE: telegramImmediateAlertRepo.HUMAN_ALERT_LOCK_NAMESPACE,
  IMMEDIATE_ALERT_RETRY_DELAYS_MS,
  IMMEDIATE_ALERT_WORKER_ERROR_RETRY_MS,
  IMMEDIATE_MESSAGE_LIMIT,
  buildImmediateAlertMessage,
  bookingReadyEventKey,
  createImmediateAlertQueueRunner,
  createTelegramImmediateAlertService,
  delayUntilNextImmediateAlert,
  deliveryFailureEventKey,
  getImmediateAlertContext,
  humanInterventionEventKey,
  queuePreparedAlert: defaultService.queuePreparedAlert,
  retryDelayMsForAttempt,
  runImmediateAlertQueue,
  startTelegramImmediateAlertRecovery,
  wakeImmediateAlertQueue,
  sendHumanInterventionAlert: defaultService.sendHumanInterventionAlert,
  sendDeliveryFailureAlert: defaultService.sendDeliveryFailureAlert,
  sendBookingReadyAlert: defaultService.sendBookingReadyAlert,
};
