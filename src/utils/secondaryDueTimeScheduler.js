"use strict";

// SQL scheduling hints are read-only and NEVER authorize a send. The existing
// sender-owned candidate query, one-shot claim and pre-send checks remain the
// sole authorities. Reuse the candidate query's sender, consent, ad and
// appointment predicates so an unrelated conversation cannot keep Neon awake.
const { createAdaptiveWorkerTimer } = require("./adaptiveWorkerTimer");
const { createCoalescedImmediateWake } = require("./followUpWakePolicy");
const { recordWorkerRun } = require("./workerActivityMetrics");
const { withDatabaseActivitySource } = require("./databaseActivityContext");
const { recordWorkerWake, recordSecondaryDueDecision } =
  require("./refreshWakeDiagnostics");

const IDLE_RECHECK_MS = 60 * 60 * 1000;
const ERROR_RETRY_MS = 5 * 60 * 1000;
const BACKLOG_RECHECK_MS = 10 * 1000;
// A signed delivery receipt can complete the first AI reply's eligibility,
// but multiple status ticks need only one short deferred check. Booking,
// opt-out, new messages and rule changes still wake immediately.
const DELIVERY_RECEIPT_WAKE_DELAY_MS = 3 * 1000;
const CLINIC_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Derive the read-only due-time hint from the CURRENT candidate selector.
// A mismatch fails closed at module initialization, preventing a future
// eligibility refactor from silently desynchronizing scheduled sends.
function deriveSecondaryPotentialDueSql(candidateSql, {
  fromTable, dueExpression, quietWindowEndMarker, orderMarker,
  retryAtExpression, deferredReadyPredicate,
} = {}) {
  const prefix = " SELECT c.id AS contact_id";
  const fromMarker = "\n FROM " + fromTable + " rule";
  const windowStart = "   AND EXTRACT(HOUR FROM ($4::timestamptz AT TIME ZONE 'Asia/Kuala_Lumpur'))";
  const fromIndex = candidateSql.indexOf(fromMarker);
  const startIndex = candidateSql.indexOf(windowStart);
  const endIndex = candidateSql.indexOf(quietWindowEndMarker, startIndex);
  const orderIndex = candidateSql.lastIndexOf(orderMarker || "\n ORDER BY inbound.created_at,c.id,rule.slot_hours");
  if (!candidateSql.startsWith("\n" + prefix) || fromIndex < 0 ||
      startIndex < fromIndex || endIndex <= startIndex ||
      orderIndex <= endIndex || !candidateSql.slice(orderIndex).includes("LIMIT $5")) {
    throw new Error("Secondary due-time hint does not match the approved candidate query.");
  }
  const readyExpression = retryAtExpression
    ? `GREATEST(${dueExpression},${retryAtExpression})` : dueExpression;
  const head = " SELECT " + readyExpression + " AS due_at";
  let sql = head + candidateSql.slice(fromIndex, startIndex);
  // Overdue work is considered only during its existing eight-hour window.
  // The original send query still applies quiet hours and expiration guards.
  sql += "   AND " + dueExpression + " > $4::timestamptz - INTERVAL '8 hours'\n";
  sql += candidateSql.slice(endIndex, orderIndex);
  if (retryAtExpression && deferredReadyPredicate) {
    if (!sql.includes(deferredReadyPredicate)) throw Error("Deferred due hint predicate mismatch");
    sql = sql.replaceAll(deferredReadyPredicate,"attempted.status<>'deferred' OR attempted.retry_after IS NULL");
  }
  // Only five binding values are needed by the hint. Original candidate
  // selectors bind activation cutoff as $6 after a discarded LIMIT $5.
  sql = sql.replaceAll("$6", "$5").replaceAll("$7", "$6").replaceAll("$8", "$7").replaceAll("$9", "$8");
  return `SELECT MIN(due_at) FILTER (WHERE due_at > $4::timestamptz) AS next_due_at,
       COALESCE(BOOL_OR(due_at <= $4::timestamptz), FALSE) AS has_overdue
    FROM (${sql}) sender_due_candidates`;
}

// Malaysia has a fixed UTC+8 offset. Keep the actual service's quiet-hours
// boundary unchanged: sends are permitted from 07:00 through 23:59 MYT.
function nextAllowedClinicTime(ms) {
  const shifted = new Date(ms + CLINIC_UTC_OFFSET_MS);
  if (!Number.isFinite(shifted.getTime())) return null;
  if (shifted.getUTCHours() < 7) {
    shifted.setUTCHours(7, 0, 0, 0);
  }
  return shifted.getTime() - CLINIC_UTC_OFFSET_MS;
}

// All three secondary marketing selectors and the service selector forbid
// sends before 07:00 Malaysia time. A cheap, in-memory overnight hint is
// sufficient until clinic opening. Never cache eligibility: at 07:00 the
// normal SQL, current opt-outs, bookings and billing checks run as usual.
function quietHoursNextOpenHint(nowMs) {
  if (!Number.isFinite(nowMs)) return null;
  const local = new Date(nowMs + CLINIC_UTC_OFFSET_MS);
  if (!Number.isFinite(local.getTime()) || local.getUTCHours() >= 7) return null;
  local.setUTCHours(7, 0, 0, 0);
  return { next_due_at: new Date(local.getTime() - CLINIC_UTC_OFFSET_MS),
    has_overdue: false };
}

// Fail open if a future refactor removes a candidate selector's hard
// quiet-hours policy. Never skip SQL based solely on a configuration name.
function hasSecondaryClinicQuietHoursGuard(sql) {
  if (typeof sql !== "string") return false;
  // Require a standalone AND predicate, not a quoted or commented mention
  // of the previous policy. A removed guard disables this optimization.
  // Block-commented policy examples are not executable SQL either.
  const executable = sql.replace(/\/\*[\s\S]*?\*\//g, "");
  return /(?:^|\n)[ \t]*AND[ \t]+EXTRACT\(HOUR FROM \(\$4::timestamptz AT TIME ZONE 'Asia\/Kuala_Lumpur'\)\)[ \t\r\n]+BETWEEN[ \t]+7[ \t]+AND[ \t]+23\b/.test(executable);
}

// A read-only due hint is a superset of sendable slots. If none can be due
// yet, avoid the much heavier full candidate scan. Ambiguous or malformed
// hints always fall back to the original candidate query.
function validSecondaryDueHint(hint) {
  if (!hint || typeof hint.has_overdue !== "boolean" ||
      !Object.prototype.hasOwnProperty.call(hint, "next_due_at")) return false;
  if (hint.next_due_at === null) return true;
  return hint.next_due_at !== undefined &&
    Number.isFinite(new Date(hint.next_due_at).getTime());
}

function noPotentialDueNow(hint, nowMs) {
  if (!validSecondaryDueHint(hint) || hint.has_overdue !== false ||
      !Number.isFinite(nowMs)) return false;
  return hint.next_due_at === null ||
    new Date(hint.next_due_at).getTime() > nowMs;
}

function nextSecondaryDueDelay(hint, nowMs = Date.now(), { idleMs = IDLE_RECHECK_MS } = {}) {
  if (!hint || !Number.isFinite(nowMs)) return idleMs;
  let earliest = Infinity;
  if (hint.next_due_at != null) {
    const future = new Date(hint.next_due_at).getTime();
    if (Number.isFinite(future) && future > nowMs) {
      const adjusted = nextAllowedClinicTime(future);
      if (adjusted != null) earliest = Math.min(earliest, adjusted);
    }
  }
  // If a slot fell due overnight, the original send query would decline it
  // before 07:00. Wake exactly at the first permitted minute rather than
  // repeatedly querying during quiet hours or missing the eight-hour window.
  const clock = new Date(nowMs + CLINIC_UTC_OFFSET_MS);
  if (hint.has_overdue === true && clock.getUTCHours() < 7) {
    earliest = Math.min(earliest, nextAllowedClinicTime(nowMs));
  }
  return Number.isFinite(earliest)
    ? Math.max(1000, earliest - nowMs)
    : idleMs;
}

// Passive worker accounting. No SQL, timers, secrets, contact data or extra
// reads. Captures the few secondary legacy recovery intervals not already
// tracked by the existing adaptive worker timer.
async function measureSecondaryWorkerRun(label, run) {
  const started = Date.now();
  let failed = false;
  try {
    return await withDatabaseActivitySource(label, run);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    recordWorkerRun(label, Date.now() - started, failed);
  }
}

// Only skip events whose trusted source proves they cannot affect this
// WhatsApp number's follow-up eligibility. Missing sender details remain
// conservative: recheck, so opt-outs, bookings and legacy publishers are safe.
function secondaryEventRequiresWake(type, payload, env = process.env) {
  if (type === "conversation_changed") {
    // Verified read/name-only writes do not change either secondary selector.
    // Restrict the marker to its exact event kind; unknown events still wake.
    if (payload?.reason === "contact_state" && payload?.inboxPresentationOnly === true) return false;
    if (payload?.reason === "reaction" || payload?.followUpStateUnchanged === true ||
        payload?.reason === "lead_assignment_recovered") return false;
    if (payload?.channel && payload.channel !== "whatsapp") return false;
    if (payload?.businessPhoneNumberId != null &&
        env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID &&
        String(payload.businessPhoneNumberId) !== String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID)) {
      return false;
    }
  }
  // Lead scoring and completed Meta ad detail enrichment change only CRM
  // presentation, not the verified sender/consent/due-time eligibility.
  // A channel label on pipeline events is not sender-proof: shared lead
  // booking and opt-out changes must keep waking the secondary safeguards.
  // Only the explicitly enumerated CRM-only reasons below can be ignored.
  if (type === "pipeline_changed" &&
      (payload?.reason === "lead_scored" || payload?.reason === "meta_ad_enriched" ||
       payload?.reason === "lead_assignment_recovered")) {
    return false;
  }
  return true;
}

function createSecondaryDueScheduler({
  label, run, readNextDue, events, env,
  database, createTimer = createAdaptiveWorkerTimer,
  now = Date.now, logger = console, preflightDueHint = false,
  quietHoursPreflight = false,
} = {}) {
  if (typeof run !== "function" || typeof readNextDue !== "function" ||
      typeof events?.subscribe !== "function") {
    throw new TypeError("Secondary due-time scheduler needs a runner, read-only hint and events.");
  }
  let timer = null;
  let subscriptions = [];
  function wake(delayMs=0) { return timer?.wake(delayMs) || false; }
  const coalescedWake = createCoalescedImmediateWake(() => wake(0));
  const coalescedReceiptWake = createCoalescedImmediateWake(
    () => wake(DELIVERY_RECEIPT_WAKE_DELAY_MS));
  const lane = label === "Secondary WhatsApp marketing followup scheduler"
    ? "secondary_marketing" : "secondary_service";
  function recordDecision(decision) {
    try { recordSecondaryDueDecision(lane, decision); } catch (_) {}
  }
  function observeEvent(type, payload, eligible) {
    // Only fixed-label, in-memory counters. Diagnostic errors must never
    // disrupt scheduling, and booking/opt-out signals retain their timing.
    if (!eligible) {
      recordWorkerWake(lane, type, payload, "ignored", env);
      return;
    }
    const statusOnly = type === "conversation_changed" &&
      payload?.reason === "delivery_status";
    const signal = statusOnly ? coalescedReceiptWake : coalescedWake;
    const queued = signal();
    if (statusOnly && !queued) recordDecision("receipt_coalesced");
    recordWorkerWake(lane, type, payload,
      queued ? "queued" : "coalesced", env);
  }
  function start() {
    if (timer && !timer.state().stopped) return false;
    timer = createTimer({
      label,
      errorRetryDelayMs: ERROR_RETRY_MS,
      logger,
      now,
      run: async () => {
        // All actual send selectors prohibit sends during clinic quiet hours.
        // Return a clock-only hint rather than waking Neon to discover that.
        // Next opening always performs a fresh database read, never a send.
        if (quietHoursPreflight) {
          const quietHint = quietHoursNextOpenHint(now());
          if (quietHint) {
            recordDecision("quiet_hours_skipped");
            recordDecision("scan_skipped");
            return { outcome: { attempted: 0, accepted: 0 },
              hint: quietHint, quietHoursSkipped: true };
          }
        }
        // Only enabled for selectors whose potential-due SQL retains every
        // required eligibility guard. Read it freshly on each event/recovery
        // wake, so bookings, opt-outs and newly qualified replies cannot use
        // an outdated hint. No cached contacts, SQL writes or send shortcuts.
        if (preflightDueHint) {
          let earlyHint = null;
          recordDecision("hint_query");
          try {
            earlyHint = await readNextDue({ env, database, now: new Date(now()) });
          } catch {
            // The optimization must never postpone a potentially due send.
            // An unreliable hint falls back to the existing full selector;
            // its own error handling and provider safeguards remain intact.
            recordDecision("hint_failed");
            logger.warn?.("Secondary due-hint preflight failed; using full candidate scan.");
          }
          if (noPotentialDueNow(earlyHint, now())) {
            recordDecision("scan_skipped");
            return { outcome: { attempted: 0, accepted: 0 }, hint: earlyHint };
          }
          if (!validSecondaryDueHint(earlyHint)) recordDecision("hint_uncertain");
          else if (earlyHint.has_overdue) recordDecision("due_found");
        }
        recordDecision("scan_performed");
        const outcome = await run({ env, database });
        if (outcome?.disabled) return { disabled: true };
        // A full batch always schedules another run in ten seconds. Its due
        // hint is discarded by delayForResult, so avoid that expensive query
        // until the backlog has drained. Existing one-shot send checks remain.
        if (Number(outcome?.attempted || 0) >= 10) {
          recordDecision("backlog");
          return { outcome, hint: null };
        }
        recordDecision("post_hint_query");
        const hint = await readNextDue({ env, database, now: new Date(now()) });
        return { outcome, hint };
      },
      delayForResult: result => {
        if (result?.disabled) return null;
        if (result?.quietHoursSkipped) {
          // If the clock crosses 07:00 between the in-memory hint and this
          // scheduling callback, recover after 1s rather than sleeping 1h.
          const opensAt = new Date(result.hint.next_due_at).getTime();
          return Number.isFinite(opensAt)
            ? Math.max(1000, opensAt - now()) : ERROR_RETRY_MS;
        }
        // Continue draining a genuine due batch without a five-minute poll.
        // Attempts are one-shot and remain protected by the original ledger.
        if (Number(result?.outcome?.attempted || 0) >= 10) return BACKLOG_RECHECK_MS;
        // A missing hint is not proof that no future work is due. After
        // the safe full-scan fallback, recheck in five minutes rather than
        // allowing the ordinary one-hour idle backstop to postpone work.
        if (preflightDueHint && !validSecondaryDueHint(result?.hint)) return ERROR_RETRY_MS;
        return nextSecondaryDueDelay(result?.hint, now());
      },
    });
    subscriptions = [
      events.subscribe("conversation_changed", payload => {
        observeEvent("conversation_changed", payload,
          secondaryEventRequiresWake("conversation_changed", payload, env));
      }),
      events.subscribe("pipeline_changed", payload => {
        observeEvent("pipeline_changed", payload,
          secondaryEventRequiresWake("pipeline_changed", payload, env));
      }),
      events.subscribe("config_changed", payload => observeEvent("config_changed", payload, true)),
      events.subscribe("secondary_followup_rules_changed", payload =>
        observeEvent("secondary_followup_rules_changed", payload, true)),
    ];
    timer.start(0); // Restart recovery also inspects already-due slots.
    return true;
  }
  function stop() {
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    timer?.stop();
    timer = null;
  }
  return { start, stop, wake, state: () => timer?.state() || { stopped: true } };
}

module.exports = {
  IDLE_RECHECK_MS, ERROR_RETRY_MS, BACKLOG_RECHECK_MS,
  DELIVERY_RECEIPT_WAKE_DELAY_MS,
  deriveSecondaryPotentialDueSql, nextAllowedClinicTime,
  hasSecondaryClinicQuietHoursGuard, quietHoursNextOpenHint,
  validSecondaryDueHint, noPotentialDueNow, nextSecondaryDueDelay,
  measureSecondaryWorkerRun, createSecondaryDueScheduler,
  secondaryEventRequiresWake,
};
