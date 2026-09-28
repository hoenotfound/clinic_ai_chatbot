const crypto = require("crypto");
const telegramImmediateAlertRepo = require("../db/telegramImmediateAlertRepo");
const clinicConfig = require("../config/clinicConfig");
const { getConversionProfile } = require("../config/conversionProfiles");
const { getOperationalLabels } = require("../utils/businessTerminology");
const { createAdaptiveWorkerTimer } = require("../utils/adaptiveWorkerTimer");
const realtimeEvents = require("../utils/realtimeEvents");
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
const DELIVERY_ALERT_COOLDOWN_MINUTES = 15;
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

function staffWaitingReference(alert) {
  if (alert?.alert_type !== "staff_waiting") return null;
  const match = /^staff_waiting:(\d+):(\d+)$/.exec(String(alert.event_key || ""));
  if (!match) return null;

  const contactId = Number(match[1]);
  const waitingMessageId = Number(match[2]);
  if (
    !Number.isSafeInteger(contactId) ||
    contactId < 1 ||
    !Number.isSafeInteger(waitingMessageId) ||
    waitingMessageId < 1 ||
    Number(alert.contact_id) !== contactId
  ) {
    return null;
  }

  return { contactId, waitingMessageId };
}

async function isLatestBookingReadyAlert(
  alert,
  query = pool.query.bind(pool)
) {
  const result = await query(
    `SELECT NOT EXISTS (
       SELECT 1
       FROM telegram_immediate_alerts newer
       WHERE newer.contact_id = $1
         AND newer.alert_type = 'booking_ready'
         AND newer.id > $2
         AND newer.lead_id IS NOT DISTINCT FROM $3::integer
     ) AS is_latest`,
    [Number(alert.contact_id), Number(alert.id), alert.lead_id || null]
  );
  return Boolean(result.rows[0]?.is_latest);
}

function shouldWakeConversationSummary(alert) {
  return ["human_intervention", "booking_ready", "staff_waiting"].includes(
    String(alert?.alert_type || "")
  );
}

function publishImmediateTerminalState(alert) {
  if (!alert || !["sent", "failed", "cancelled"].includes(alert.status)) return;
  if (!shouldWakeConversationSummary(alert)) return;
  realtimeEvents.publishInternal("telegram_alert_terminal", {
    alertId: alert.id,
    contactId: alert.contact_id,
    leadId: alert.lead_id || null,
    alertType: alert.alert_type,
    status: alert.status,
  });
}

async function shouldSendImmediateAlert(
  alert,
  query = pool.query.bind(pool)
) {
  if (alert?.alert_type === "booking_ready") {
    return isLatestBookingReadyAlert(alert, query);
  }
  if (alert?.alert_type !== "staff_waiting") return true;

  const reference = staffWaitingReference(alert);
  if (!reference) return false;

  const result = await query(
    `SELECT EXISTS (
       SELECT 1
       FROM contacts c
       JOIN messages waiting_message
         ON waiting_message.id = $2
        AND waiting_message.contact_id = c.id
        AND waiting_message.role = 'user'
       WHERE c.id = $1
         AND (c.mode = 'human' OR c.needs_attention = true)
         AND NOT EXISTS (
           SELECT 1
           FROM messages outbound
           WHERE outbound.contact_id = c.id
             AND outbound.role = 'assistant'
             AND outbound.sent_by_username IS NOT NULL
             AND outbound.is_automated_follow_up = false
             AND (
               outbound.delivery_status IS NULL
               OR outbound.delivery_status NOT IN ('failed', 'unknown')
             )
             AND (outbound.created_at, outbound.id) >
                 (waiting_message.created_at, waiting_message.id)
         )
     ) AS waiting`,
    [reference.contactId, reference.waitingMessageId]
  );
  return Boolean(result.rows[0]?.waiting);
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

  if (isBookingReady && String(details.staffSummary || "").trim()) {
    lines.push(
      "",
      "AI Summary:",
      String(details.staffSummary).trim().slice(0, 600)
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
  shouldSendAlert = shouldSendImmediateAlert,
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
      const recovered = await repository.markExhaustedStale() || [];
      for (const alert of recovered) {
        if (alert.status === "failed") publishImmediateTerminalState(alert);
      }
      const alerts = await repository.claimReady();

      for (const alert of alerts) {
        try {
          const stillApplies = await shouldSendAlert(alert);
          if (!stillApplies) {
            const cancelled = await repository.markCancelled(
              alert.id,
              alert.lease_token,
              alert.alert_type === "staff_waiting"
                ? "Staff-waiting reminder resolved before Telegram delivery."
                : alert.alert_type === "booking_ready"
                  ? "Superseded by newer Booking Ready details before Telegram delivery."
                  : "Alert no longer applies."
            );
            publishImmediateTerminalState(cancelled);
            continue;
          }

          await sendMessage({
            token: env.TELEGRAM_BOT_TOKEN,
            chatId: env.TELEGRAM_CHAT_ID,
            text: alert.message_text,
          });
          const sent = await repository.markSent(alert.id, alert.lease_token);
          publishImmediateTerminalState(sent);
          sentCount += 1;
        } catch (err) {
          failedCount += 1;
          const retryDelaySeconds = Math.ceil(
            retryDelayMsForAttempt(alert.attempts) / 1000
          );
          const failed = await repository.markFailed(
            alert.id,
            alert.lease_token,
            err,
            { retryDelaySeconds }
          );
          publishImmediateTerminalState(failed);
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
    leadId = null,
    messageText,
    cooldownMinutes = 0,
  }) {
    if (!isTelegramEnabled(env)) return { status: "disabled" };

    const queued = await repository.queueAlert({
      eventKey,
      type,
      contactId,
      leadId,
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
    transactionClient = null,
  }) {
    if (!isTelegramEnabled(env)) return { status: "disabled" };

    const context = await getContext(
      contactId,
      transactionClient ? transactionClient.query.bind(transactionClient) : undefined
    );
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
      cooldownMinutes = DELIVERY_ALERT_COOLDOWN_MINUTES;
    }

    const messageText = buildImmediateAlertMessage({
      type,
      context,
      reason,
      details,
      env,
      config,
    });

    const alertInput = {
      eventKey,
      type,
      contactId,
      leadId: context.lead_id,
      messageText,
      cooldownMinutes,
    };

    // The contact row is locked by the Booking Ready transaction. Persist its
    // alert in that same transaction so a crash cannot commit the outcome
    // without leaving recoverable Telegram work behind.
    if (type === "booking_ready" && transactionClient) {
      const queryInTransaction = transactionClient.query.bind(transactionClient);
      await repository.cancelOlderPendingBookingReady(alertInput, queryInTransaction);
      const queued = await repository.insertAlert(alertInput, queryInTransaction);
      return queued
        ? { status: "queued", alertId: queued.id }
        : { status: "suppressed" };
    }

    return queuePreparedAlert(alertInput);
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
  DELIVERY_ALERT_COOLDOWN_MINUTES,
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
  isLatestBookingReadyAlert,
  publishImmediateTerminalState,
  shouldSendImmediateAlert,
  staffWaitingReference,
  queuePreparedAlert: defaultService.queuePreparedAlert,
  retryDelayMsForAttempt,
  runImmediateAlertQueue,
  startTelegramImmediateAlertRecovery,
  wakeImmediateAlertQueue,
  sendHumanInterventionAlert: defaultService.sendHumanInterventionAlert,
  sendDeliveryFailureAlert: defaultService.sendDeliveryFailureAlert,
  sendBookingReadyAlert: defaultService.sendBookingReadyAlert,
};
