const { pool } = require("../db/db");
const {
  formatWhatsappNumber,
  isTelegramEnabled,
  postTelegramMessage,
  temperatureLabel,
} = require("./telegramAlertService");
const {
  getImmediateAlertContext,
} = require("./telegramImmediateAlertService");

const STAFF_WAITING_MINUTES = 10;
const STAFF_WAITING_CHECK_INTERVAL_MS = 60 * 1000;
const STAFF_WAITING_BATCH_SIZE = 10;
const STAFF_WAITING_MESSAGE_LIMIT = 4000;
const LATEST_MESSAGE_LIMIT = 600;
const STAFF_WAITING_LOCK_NAMESPACE = 24683;

function clean(value, fallback = "Not captured") {
  const text = String(value || "").trim();
  return text || fallback;
}

function buildInboxUrl(contactId, env = process.env) {
  const baseUrl = String(env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  if (!baseUrl || !contactId) return null;
  return `${baseUrl}/inbox?contact=${encodeURIComponent(contactId)}`;
}

function staffWaitingEventKey(contactId, waitingSinceMessageId) {
  return `staff_waiting:${contactId}:${waitingSinceMessageId}`;
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
       latest_waiting.id AS waiting_since_message_id,
       latest_waiting.created_at AS waiting_since,
       latest_waiting.id AS latest_customer_message_id,
       GREATEST(
         1,
         FLOOR(EXTRACT(EPOCH FROM (now() - latest_waiting.created_at)) / 60)::integer
       ) AS waiting_minutes
     FROM contacts c
     LEFT JOIN LATERAL (
       SELECT m.id, m.created_at
       FROM messages m
       WHERE m.contact_id = c.id
         AND m.role = 'assistant'
         AND m.sent_by_username IS NOT NULL
         AND m.is_automated_follow_up = false
         AND (
           m.delivery_status IS NULL
           OR m.delivery_status NOT IN ('failed', 'unknown')
         )
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 1
     ) last_valid_staff_outbound ON true
     JOIN LATERAL (
       SELECT m.id, m.created_at
       FROM messages m
       WHERE m.contact_id = c.id
         AND m.role = 'user'
         AND (
           last_valid_staff_outbound.id IS NULL
           OR (m.created_at, m.id) >
              (last_valid_staff_outbound.created_at, last_valid_staff_outbound.id)
         )
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 1
     ) latest_waiting ON true
     WHERE (c.mode = 'human' OR c.needs_attention = true)
       AND latest_waiting.created_at <=
           now() - ($1::integer * interval '1 minute')
       AND NOT EXISTS (
         SELECT 1
         FROM telegram_immediate_alerts a
         WHERE a.event_key =
           'staff_waiting:' || c.id::text || ':' || latest_waiting.id::text
       )
     ORDER BY latest_waiting.created_at ASC, c.id ASC
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
  database = pool,
  getContext = getImmediateAlertContext,
  stillWaiting = isStillWaitingForStaff,
  sendMessage = postTelegramMessage,
} = {}) {
  return async function sendStaffWaitingAlert({
    contactId,
    waitingSinceMessageId,
    waitingMinutes,
  }) {
    if (!isTelegramEnabled(env)) return { status: "disabled" };

    const eventKey = staffWaitingEventKey(contactId, waitingSinceMessageId);
    const client = await database.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      // Keep the durable sent marker out of the database until Telegram has
      // actually accepted the reminder. The transaction-scoped lock serializes
      // competing app instances for this episode, while a process crash rolls
      // the transaction back automatically instead of muting the reminder forever.
      await client.query(
        "SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
        [STAFF_WAITING_LOCK_NAMESPACE, waitingSinceMessageId]
      );

      const existing = await client.query(
        "SELECT id FROM telegram_immediate_alerts WHERE event_key = $1 LIMIT 1",
        [eventKey]
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        transactionStarted = false;
        return { status: "suppressed" };
      }

      const query = client.query.bind(client);
      const context = await getContext(contactId, query);
      if (!context) {
        await client.query("COMMIT");
        transactionStarted = false;
        return { status: "skipped", reason: "contact-not-found" };
      }

      // Re-check immediately before building/sending the alert. Only an actual
      // staff-authored outbound resolves the waiting episode; an AI handoff
      // acknowledgement or automated follow-up must not masquerade as the staff
      // response this reminder is waiting for.
      if (!await stillWaiting(contactId, waitingSinceMessageId, query)) {
        await client.query("COMMIT");
        transactionStarted = false;
        return { status: "resolved" };
      }

      const text = buildStaffWaitingAlertMessage({ context, waitingMinutes, env });
      const result = await sendMessage({
        token: env.TELEGRAM_BOT_TOKEN,
        chatId: env.TELEGRAM_CHAT_ID,
        text,
      });

      // Only a successful Telegram send becomes the permanent one-per-message
      // marker. If sendMessage throws, ROLLBACK leaves no marker and a later
      // sweep can retry the reminder.
      await client.query(
        `INSERT INTO telegram_immediate_alerts (event_key, alert_type, contact_id)
         VALUES ($1, 'staff_waiting', $2)
         ON CONFLICT (event_key) DO NOTHING`,
        [eventKey, contactId]
      );
      await client.query("COMMIT");
      transactionStarted = false;
      return { status: "sent", result };
    } catch (err) {
      if (transactionStarted) {
        await client.query("ROLLBACK").catch(() => {});
      }
      throw err;
    } finally {
      client.release();
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
  STAFF_WAITING_LOCK_NAMESPACE,
  STAFF_WAITING_MINUTES,
  buildStaffWaitingAlertMessage,
  createStaffWaitingAlertRunner,
  createStaffWaitingAlertService,
  findWaitingStaffOwnedConversations,
  isStillWaitingForStaff,
  runStaffWaitingAlerts,
  staffWaitingEventKey,
  startStaffWaitingAlerts,
};
