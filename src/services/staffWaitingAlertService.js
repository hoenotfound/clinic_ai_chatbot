const { pool } = require("../db/db");
const {
  formatWhatsappNumber,
  isTelegramEnabled,
  postTelegramMessage,
  temperatureLabel,
} = require("./telegramAlertService");
const {
  claimImmediateAlert,
  getImmediateAlertContext,
  releaseImmediateAlert,
} = require("./telegramImmediateAlertService");

const STAFF_WAITING_MINUTES = 10;
const STAFF_WAITING_CHECK_INTERVAL_MS = 60 * 1000;
const STAFF_WAITING_BATCH_SIZE = 10;
const STAFF_WAITING_MESSAGE_LIMIT = 4000;
const LATEST_MESSAGE_LIMIT = 600;

function clean(value, fallback = "Not captured") {
  const text = String(value || "").trim();
  return text || fallback;
}

function buildInboxUrl(contactId, env = process.env) {
  const baseUrl = String(env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  if (!baseUrl || !contactId) return null;
  return `${baseUrl}/inbox?contact=${encodeURIComponent(contactId)}`;
}

async function findWaitingStaffOwnedConversations(
  {
    waitMinutes = STAFF_WAITING_MINUTES,
    limit = STAFF_WAITING_BATCH_SIZE,
  } = {},
  query = pool.query.bind(pool)
) {
  const result = await query(
    `SELECT
       c.id AS contact_id,
       first_waiting.id AS waiting_since_message_id,
       first_waiting.created_at AS waiting_since,
       latest_waiting.id AS latest_customer_message_id,
       GREATEST(
         1,
         FLOOR(EXTRACT(EPOCH FROM (now() - first_waiting.created_at)) / 60)::integer
       ) AS waiting_minutes
     FROM contacts c
     LEFT JOIN LATERAL (
       SELECT m.id, m.created_at
       FROM messages m
       WHERE m.contact_id = c.id
         AND m.role = 'assistant'
         AND (
           m.delivery_status IS NULL
           OR m.delivery_status NOT IN ('failed', 'unknown')
         )
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 1
     ) last_valid_outbound ON true
     JOIN LATERAL (
       SELECT m.id, m.created_at
       FROM messages m
       WHERE m.contact_id = c.id
         AND m.role = 'user'
         AND (
           last_valid_outbound.id IS NULL
           OR (m.created_at, m.id) >
              (last_valid_outbound.created_at, last_valid_outbound.id)
         )
       ORDER BY m.created_at ASC, m.id ASC
       LIMIT 1
     ) first_waiting ON true
     JOIN LATERAL (
       SELECT m.id, m.created_at
       FROM messages m
       WHERE m.contact_id = c.id
         AND m.role = 'user'
         AND (
           last_valid_outbound.id IS NULL
           OR (m.created_at, m.id) >
              (last_valid_outbound.created_at, last_valid_outbound.id)
         )
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 1
     ) latest_waiting ON true
     WHERE (c.mode = 'human' OR c.needs_attention = true)
       AND first_waiting.created_at <=
           now() - ($1::integer * interval '1 minute')
       AND NOT EXISTS (
         SELECT 1
         FROM telegram_immediate_alerts a
         WHERE a.event_key =
           'staff_waiting:' || c.id::text || ':' || first_waiting.id::text
       )
     ORDER BY first_waiting.created_at ASC, c.id ASC
     LIMIT $2`,
    [waitMinutes, limit]
  );
  return result.rows;
}

async function isStillWaitingForStaff(
  contactId,
  waitingSinceMessageId,
  query = pool.query.bind(pool)
) {
  const result = await query(
    `SELECT EXISTS (
       SELECT 1
       FROM contacts c
       JOIN messages first_waiting
         ON first_waiting.id = $2
        AND first_waiting.contact_id = c.id
        AND first_waiting.role = 'user'
       WHERE c.id = $1
         AND (c.mode = 'human' OR c.needs_attention = true)
         AND NOT EXISTS (
           SELECT 1
           FROM messages outbound
           WHERE outbound.contact_id = c.id
             AND outbound.role = 'assistant'
             AND (
               outbound.delivery_status IS NULL
               OR outbound.delivery_status NOT IN ('failed', 'unknown')
             )
             AND (outbound.created_at, outbound.id) >
                 (first_waiting.created_at, first_waiting.id)
         )
     ) AS waiting`,
    [contactId, waitingSinceMessageId]
  );
  return Boolean(result.rows[0]?.waiting);
}

function buildStaffWaitingAlertMessage({ context, waitingMinutes, env = process.env }) {
  const name = clean(context.name || context.whatsapp_profile_name, "Unknown contact");
  const lines = [
    "⏰ Customer Waiting for Staff",
    "",
    `${name} (${formatWhatsappNumber(context.whatsapp_number)})`,
    "",
    "Customer still has an unanswered message that needs staff attention.",
    `Waiting: ${Math.max(1, Number(waitingMinutes) || 1)} minutes`,
    `Temperature: ${temperatureLabel(context.temperature)}`,
    `Stage: ${clean(context.stage_name)}`,
    `Treatment: ${clean(context.treatment_interest)}`,
    `Branch: ${clean(context.branch_name)}`,
  ];

  if (context.latest_customer_message) {
    lines.push(
      "",
      "Latest Customer Message:",
      clean(context.latest_customer_message).slice(0, LATEST_MESSAGE_LIMIT)
    );
  }

  lines.push(
    "",
    "Action: Reply to the customer. If you want AI to handle future messages, Return to AI after replying."
  );

  const inboxUrl = buildInboxUrl(context.contact_id, env);
  if (inboxUrl) lines.push("", `Inbox: ${inboxUrl}`);

  const message = lines.join("\n");
  return message.length <= STAFF_WAITING_MESSAGE_LIMIT
    ? message
    : `${message.slice(0, STAFF_WAITING_MESSAGE_LIMIT - 3)}...`;
}

function createStaffWaitingAlertService({
  env = process.env,
  getContext = getImmediateAlertContext,
  claimAlert = claimImmediateAlert,
  releaseAlert = releaseImmediateAlert,
  stillWaiting = isStillWaitingForStaff,
  sendMessage = postTelegramMessage,
} = {}) {
  return async function sendStaffWaitingAlert({
    contactId,
    waitingSinceMessageId,
    waitingMinutes,
  }) {
    if (!isTelegramEnabled(env)) return { status: "disabled" };

    const eventKey = `staff_waiting:${contactId}:${waitingSinceMessageId}`;
    const claimed = await claimAlert({
      eventKey,
      type: "staff_waiting",
      contactId,
    });
    if (!claimed) return { status: "suppressed" };

    try {
      const context = await getContext(contactId);
      if (!context) {
        await releaseAlert(eventKey).catch(() => {});
        return { status: "skipped", reason: "contact-not-found" };
      }

      // Re-check immediately before building/sending the alert. A successful
      // outbound reply resolves the episode. Keeping Staff mode active, or an
      // outstanding attention flag after Return to AI, keeps it eligible.
      if (!await stillWaiting(contactId, waitingSinceMessageId)) {
        await releaseAlert(eventKey).catch(() => {});
        return { status: "resolved" };
      }

      const text = buildStaffWaitingAlertMessage({ context, waitingMinutes, env });
      const result = await sendMessage({
        token: env.TELEGRAM_BOT_TOKEN,
        chatId: env.TELEGRAM_CHAT_ID,
        text,
      });
      return { status: "sent", result };
    } catch (err) {
      // Do not permanently consume the reminder if Telegram was unavailable.
      await releaseAlert(eventKey).catch(() => {});
      throw err;
    }
  };
}

const sendStaffWaitingAlert = createStaffWaitingAlertService();

function createStaffWaitingAlertRunner({
  findWaiting = findWaitingStaffOwnedConversations,
  sendAlert = sendStaffWaitingAlert,
  env = process.env,
} = {}) {
  let sweepRunning = false;

  return async function runStaffWaitingAlerts() {
    if (sweepRunning || !isTelegramEnabled(env)) return;
    sweepRunning = true;
    try {
      const candidates = await findWaiting({
        waitMinutes: STAFF_WAITING_MINUTES,
        limit: STAFF_WAITING_BATCH_SIZE,
      });
      for (const candidate of candidates) {
        try {
          await sendAlert({
            contactId: candidate.contact_id,
            waitingSinceMessageId: candidate.waiting_since_message_id,
            waitingMinutes: candidate.waiting_minutes,
          });
        } catch (err) {
          console.error(
            `Telegram staff-waiting alert failed for contact ${candidate.contact_id}:`,
            err
          );
        }
      }
    } catch (err) {
      console.error("Telegram staff-waiting sweep failed:", err);
    } finally {
      sweepRunning = false;
    }
  };
}

const runStaffWaitingAlerts = createStaffWaitingAlertRunner();

function startStaffWaitingAlerts() {
  runStaffWaitingAlerts();
  const timer = setInterval(
    runStaffWaitingAlerts,
    STAFF_WAITING_CHECK_INTERVAL_MS
  );
  return () => clearInterval(timer);
}

module.exports = {
  STAFF_WAITING_BATCH_SIZE,
  STAFF_WAITING_CHECK_INTERVAL_MS,
  STAFF_WAITING_MINUTES,
  buildStaffWaitingAlertMessage,
  createStaffWaitingAlertRunner,
  createStaffWaitingAlertService,
  findWaitingStaffOwnedConversations,
  isStillWaitingForStaff,
  runStaffWaitingAlerts,
  startStaffWaitingAlerts,
};
