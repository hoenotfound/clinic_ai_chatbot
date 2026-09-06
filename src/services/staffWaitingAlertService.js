const { pool } = require("../db/db");
const realtimeEvents = require("../utils/realtimeEvents");
const { createAdaptiveWorkerTimer } = require("../utils/adaptiveWorkerTimer");
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
// Retained as the retry delay/export. Normal operation sleeps until the next
// conversation can actually reach the waiting threshold instead of polling.
const STAFF_WAITING_CHECK_INTERVAL_MS = 60 * 1000;
const STAFF_WAITING_BATCH_SIZE = 10;
const STAFF_WAITING_MESSAGE_LIMIT = 4000;
const LATEST_MESSAGE_LIMIT = 600;
const STAFF_WAITING_LOCK_NAMESPACE = 24683;

let staffWaitingWorker = null;

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

function staffWaitingCandidateJoins() {
  return `
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
       AND NOT EXISTS (
         SELECT 1
         FROM telegram_immediate_alerts a
         WHERE a.event_key =
           'staff_waiting:' || c.id::text || ':' || latest_waiting.id::text
       )`;
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
     ${staffWaitingCandidateJoins()}
       AND latest_waiting.created_at <=
           now() - ($1::integer * interval '1 minute')
     ORDER BY latest_waiting.created_at ASC, c.id ASC
     LIMIT $2`,
    [waitMinutes, limit]
  );
  return result.rows;
}

/**
 * Returns the first threshold time for any currently unanswered staff-owned
 * conversation. The worker can then sleep until that exact time instead of
 * polling Postgres every minute. Activity wakes it immediately to recalculate.
 */
async function findNextStaffWaitingDueAt(
  { waitMinutes = STAFF_WAITING_MINUTES } = {},
  query = pool.query.bind(pool)
) {
  const result = await query(
    `SELECT MIN(
       latest_waiting.created_at + ($1::integer * interval '1 minute')
     ) AS due_at
     ${staffWaitingCandidateJoins()}`,
    [waitMinutes]
  );
  return result.rows[0]?.due_at || null;
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
  findNextDue = findNextStaffWaitingDueAt,
  sendAlert = sendStaffWaitingAlert,
  env = process.env,
  scheduleRetry = null,
} = {}) {
  let sweepRunning = false;

  return async function runStaffWaitingAlerts() {
    if (sweepRunning || !isTelegramEnabled(env)) {
      return { candidateCount: 0, failedCount: 0, nextDueAt: null };
    }

    sweepRunning = true;
    let failedCount = 0;
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
          failedCount += 1;
          console.error(
            `Telegram staff-waiting alert failed for contact ${candidate.contact_id}:`,
            err
          );
        }
      }

      if (failedCount > 0 && typeof scheduleRetry === "function") {
        scheduleRetry(STAFF_WAITING_CHECK_INTERVAL_MS);
      }

      const nextDueAt = failedCount === 0
        ? await findNextDue({ waitMinutes: STAFF_WAITING_MINUTES })
        : null;
      return { candidateCount: candidates.length, failedCount, nextDueAt };
    } catch (err) {
      console.error("Telegram staff-waiting sweep failed:", err);
      if (typeof scheduleRetry === "function") {
        scheduleRetry(STAFF_WAITING_CHECK_INTERVAL_MS);
      }
      return { candidateCount: 0, failedCount: 1, nextDueAt: null };
    } finally {
      sweepRunning = false;
    }
  };
}

function wakeStaffWaitingAlerts(delayMs = 0) {
  return staffWaitingWorker?.wake(delayMs) || false;
}

function delayUntilNextStaffWaitingAlert(result) {
  if (!result?.nextDueAt) return null;
  const timestamp = Date.parse(result.nextDueAt);
  if (Number.isNaN(timestamp)) return STAFF_WAITING_CHECK_INTERVAL_MS;
  return Math.max(1000, timestamp - Date.now());
}

const runStaffWaitingAlerts = createStaffWaitingAlertRunner({
  scheduleRetry: wakeStaffWaitingAlerts,
});

function startStaffWaitingAlerts() {
  if (!isTelegramEnabled()) return () => {};
  if (staffWaitingWorker && !staffWaitingWorker.state().stopped) {
    return () => staffWaitingWorker.stop();
  }

  staffWaitingWorker = createAdaptiveWorkerTimer({
    run: runStaffWaitingAlerts,
    delayForResult: delayUntilNextStaffWaitingAlert,
    errorRetryDelayMs: STAFF_WAITING_CHECK_INTERVAL_MS,
    label: "Staff waiting alert worker",
  });
  return staffWaitingWorker.start();
}

// A message or ownership change can start, resolve, or move the next waiting
// deadline. Recalculate immediately while the database is already active.
// Startup still performs one catch-up sweep for anything overdue after Render
// Free wakes from a cold start.
realtimeEvents.subscribe("conversation_changed", (payload) => {
  if (
    payload?.reason === "message" ||
    payload?.reason === "message_updated" ||
    payload?.reason === "contact_state"
  ) {
    wakeStaffWaitingAlerts(0);
  }
});

module.exports = {
  STAFF_WAITING_BATCH_SIZE,
  STAFF_WAITING_CHECK_INTERVAL_MS,
  STAFF_WAITING_LOCK_NAMESPACE,
  STAFF_WAITING_MINUTES,
  buildStaffWaitingAlertMessage,
  createStaffWaitingAlertRunner,
  createStaffWaitingAlertService,
  delayUntilNextStaffWaitingAlert,
  findNextStaffWaitingDueAt,
  findWaitingStaffOwnedConversations,
  isStillWaitingForStaff,
  runStaffWaitingAlerts,
  staffWaitingEventKey,
  startStaffWaitingAlerts,
  wakeStaffWaitingAlerts,
};
