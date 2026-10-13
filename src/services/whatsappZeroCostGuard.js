"use strict";

const crypto = require("node:crypto");
const { pool } = require("../db/db");
const clinicConfig = require("../config/clinicConfig");
const { sessionLateralSql } = require("../db/whatsappFreeEntrySessionSql");

// Billing verdicts arrive AFTER Meta accepts messages. There is no pre-send
// quote or Meta-enforced RM0 billing cap. Even strict mode cannot promise zero
// charges from external senders or previously accepted sends.
const SAFE_BUFFER_HOURS = 1;
const VERIFIED_WINDOW_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM contacts c
    ${sessionLateralSql({ contactAlias: "c", ceilingParam: "$1" })}
    JOIN messages origin ON origin.id=referral.origin_message_id
      AND origin.contact_id=c.id AND origin.role='user'
    JOIN LATERAL (
      SELECT reply.id, reply.created_at, reply.whatsapp_message_id
      FROM messages reply
      WHERE reply.contact_id=c.id AND reply.role='assistant'
        AND reply.whatsapp_message_id IS NOT NULL
        AND reply.created_at>=origin.created_at
        AND reply.created_at<origin.created_at+interval '24 hours'
      ORDER BY reply.created_at,reply.id LIMIT 1
    ) first_reply ON TRUE
    JOIN whatsapp_free_entry_pricing_evidence start_bill
      ON start_bill.wamid=first_reply.whatsapp_message_id
      AND start_bill.pricing_type='free_entry_point'
      AND start_bill.billable=false
      AND start_bill.delivery_status IN ('sent','delivered','read')
    WHERE c.channel='whatsapp'
      AND regexp_replace(c.whatsapp_number,'[^0-9]','','g')=$3::text
      AND (referral.ctwa_clid IS NOT NULL OR referral.meta_ad_id IS NOT NULL)
      AND $2::timestamptz>=first_reply.created_at
      -- The customer service window and the free-entry billing period
      -- are independent. After ~24h only approved templates may be sent.
      -- Leave a 2-minute margin for network/queue delays.
      AND ($6::text='template' OR EXISTS (
        SELECT 1 FROM messages customer
        WHERE customer.contact_id=c.id AND customer.role='user'
          AND customer.created_at <= $2::timestamptz
          AND customer.created_at > $2::timestamptz - interval '23 hours 58 minutes'
      ))
      AND $2::timestamptz<first_reply.created_at
        + (($1::integer - ${SAFE_BUFFER_HOURS}) * interval '1 hour')
      -- A persisted message without a WhatsApp message id is also unresolved.
      AND NOT EXISTS (
        SELECT 1 FROM messages earlier
        LEFT JOIN whatsapp_free_entry_pricing_evidence priced
          ON priced.wamid=earlier.whatsapp_message_id
        WHERE earlier.contact_id=c.id AND earlier.role='assistant'
          AND earlier.created_at>=first_reply.created_at
          AND earlier.created_at<$2::timestamptz
          AND earlier.id IS DISTINCT FROM $4::integer
          -- Manual Billing Hub verification and automatic Meta provider
          -- receipt proof are DISTINCT. A provider callback alone never
          -- impersonates an operator's Billing Hub inspection.
          AND NOT EXISTS (
            SELECT 1 FROM whatsapp_free_only_reconciliations audit
            WHERE audit.message_id=earlier.id AND (
              (audit.verified_billing_hub=true
                AND audit.actor NOT IN ('automatic_verified_receipt','evidence_reconciliation'))
              OR
              (audit.actor IN ('automatic_verified_receipt','evidence_reconciliation')
                AND audit.provider_pricing_type='free_entry_point'
                AND audit.provider_billable=false
                AND EXISTS (
                  SELECT 1 FROM whatsapp_free_entry_pricing_evidence receipt
                  WHERE receipt.wamid=audit.wamid
                    AND receipt.pricing_type='free_entry_point'
                    AND receipt.billable=false
                    AND receipt.delivery_status IN ('sent','delivered','read')
                ))
            )
          )
          AND NOT EXISTS(SELECT 1 FROM whatsapp_24h_service_reply_exceptions ex
                         WHERE ex.message_id=earlier.id AND ex.status='accepted'
                           AND ex.wamid=earlier.whatsapp_message_id)
          AND (earlier.whatsapp_message_id IS NULL
            OR priced.wamid IS NULL OR priced.pricing_type<>'free_entry_point'
            OR priced.billable IS DISTINCT FROM false
            OR priced.delivery_status NOT IN ('sent','delivered','read'))
          -- A cancelled/failed message which never reached Meta cannot bill.
          AND earlier.delivery_status IS DISTINCT FROM 'cancelled'
          AND earlier.delivery_status IS DISTINCT FROM 'failed'
      )
      AND NOT EXISTS (
        SELECT 1 FROM whatsapp_free_entry_followup_attempts attempt
        WHERE attempt.contact_id=c.id
          AND attempt.first_reply_message_id=first_reply.id
          AND attempt.id IS DISTINCT FROM $5::bigint
          AND NOT EXISTS (
            SELECT 1 FROM whatsapp_free_only_reconciliations audit
            WHERE audit.attempt_id=attempt.id AND (
              (audit.verified_billing_hub=true
                AND audit.actor NOT IN ('automatic_verified_receipt','evidence_reconciliation'))
              OR
              (audit.actor IN ('automatic_verified_receipt','evidence_reconciliation')
                AND audit.provider_pricing_type='free_entry_point'
                AND audit.provider_billable=false
                AND EXISTS (
                  SELECT 1 FROM whatsapp_free_entry_pricing_evidence receipt
                  WHERE receipt.wamid=audit.wamid
                    AND receipt.pricing_type='free_entry_point'
                    AND receipt.billable=false
                    AND receipt.delivery_status IN ('sent','delivered','read')
                ))
            )
          )
          AND attempt.status IN ('sending','unknown')
      )
  ) AS eligible
`;

// Evidence-only view: a verified Meta free-entry period can remain active
// while strict protection pauses sending for an unsettled earlier message.
// Never reuse this query alone to authorize a provider send.
const VERIFIED_SESSION_WINDOW_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM contacts c
    ${sessionLateralSql({ contactAlias: "c", ceilingParam: "$1" })}
    JOIN whatsapp_free_entry_referrals entry
      ON entry.contact_id=c.id AND entry.origin_message_id=referral.origin_message_id
      AND entry.source_type='ad'
    JOIN messages origin ON origin.id=referral.origin_message_id
      AND origin.contact_id=c.id AND origin.role='user'
    JOIN LATERAL (
      SELECT reply.id, reply.created_at, reply.whatsapp_message_id
      FROM messages reply
      WHERE reply.contact_id=c.id AND reply.role='assistant'
        AND reply.whatsapp_message_id IS NOT NULL
        AND reply.created_at>=origin.created_at
        AND reply.created_at<origin.created_at+interval '24 hours'
      ORDER BY reply.created_at,reply.id LIMIT 1
    ) first_reply ON TRUE
    JOIN whatsapp_free_entry_pricing_evidence priced
      ON priced.wamid=first_reply.whatsapp_message_id
      AND priced.pricing_type='free_entry_point'
      AND priced.billable=false
      AND priced.delivery_status IN ('sent','delivered','read')
    WHERE c.channel='whatsapp'
      AND regexp_replace(c.whatsapp_number,'[^0-9]','','g')=$3::text
      AND (NULLIF(BTRIM(entry.ctwa_clid),'') IS NOT NULL
           OR NULLIF(BTRIM(entry.meta_ad_id),'') IS NOT NULL)
      AND $2::timestamptz>=first_reply.created_at
      AND $2::timestamptz<first_reply.created_at
        + (($1::integer - ${SAFE_BUFFER_HOURS}) * interval '1 hour')
  ) AS verified
`;

// Do NOT interpret an environment flag as seven-day billing proof on its own.
// A post-72h, nonbillable, qualified follow-up from THIS clinic is required.
// Meta permits the FIRST reply to a genuine Click-to-WhatsApp ad entry
// without charging it, provided it is sent within 24 hours. This creates the
// free-entry window; Meta's nonbillable pricing receipt is then mandatory
// before any subsequent strict-mode send.
//
// It must be exactly the first text reply, with a saved outgoing message tied
// to this verified recipient and an actual provider-authored inbound referral.
// An ad name, stale attribution or a link to wa.me is never sufficient.
const CTWA_FIRST_REPLY_SQL = `
  SELECT EXISTS (
    SELECT 1
    FROM whatsapp_free_entry_referrals entry
    JOIN messages inbound ON inbound.id=entry.origin_message_id
      AND inbound.contact_id=entry.contact_id AND inbound.role='user'
      AND inbound.whatsapp_message_id IS NOT NULL
    JOIN contacts c ON c.id=entry.contact_id AND c.channel='whatsapp'
    JOIN messages current_send ON current_send.id=$3::integer
      AND current_send.contact_id=c.id AND current_send.role='assistant'
      AND current_send.whatsapp_message_id IS NULL
    WHERE entry.source_type='ad'
      AND (NULLIF(BTRIM(entry.ctwa_clid),'') IS NOT NULL
           OR NULLIF(BTRIM(entry.meta_ad_id),'') IS NOT NULL)
      AND regexp_replace(c.whatsapp_number,'[^0-9]','','g')=$2::text
      AND inbound.created_at <= $1::timestamptz
      AND inbound.created_at > $1::timestamptz - interval '23 hours 58 minutes'
      AND NOT EXISTS (
        SELECT 1 FROM messages earlier
        WHERE earlier.contact_id=c.id AND earlier.role='assistant'
          AND (earlier.created_at, earlier.id) >= (inbound.created_at, inbound.id)
          AND earlier.id<>current_send.id
      )
  ) AS eligible_first_reply
`;

// Independently observed nonbillable delivery on THIS clinic's actual CTWA
// free-entry session is acceptable proof even if the message was not sent
// by our automated follow-up worker (e.g., a prior non-strict manual test).
// We cannot bootstrap such evidence with strict sends after hour 72.
const SEVEN_DAY_PROOF_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM whatsapp_free_entry_referrals ad
    JOIN messages inbound ON inbound.id=ad.origin_message_id
      AND inbound.contact_id=ad.contact_id AND inbound.role='user'
    JOIN LATERAL (
      SELECT first_reply.id,first_reply.created_at,first_reply.whatsapp_message_id
      FROM messages first_reply
      WHERE first_reply.contact_id=ad.contact_id
        AND first_reply.role='assistant'
        AND first_reply.whatsapp_message_id IS NOT NULL
        AND first_reply.created_at>=inbound.created_at
        AND first_reply.created_at<inbound.created_at+interval '24 hours'
      ORDER BY first_reply.created_at,first_reply.id LIMIT 1
    ) opened ON true
    JOIN whatsapp_free_entry_pricing_evidence activation
      ON activation.wamid=opened.whatsapp_message_id
      AND activation.pricing_type='free_entry_point'
      AND activation.billable=false
      AND activation.delivery_status IN ('sent','delivered','read')
    JOIN messages observed ON observed.contact_id=ad.contact_id
      AND observed.role='assistant' AND observed.whatsapp_message_id IS NOT NULL
      AND observed.created_at>=opened.created_at+interval '72 hours'
      AND observed.created_at<opened.created_at+interval '168 hours'
      AND observed.created_at<=now()
    JOIN whatsapp_free_entry_pricing_evidence priced
      ON priced.wamid=observed.whatsapp_message_id
      AND priced.pricing_type='free_entry_point'
      AND priced.billable=false
      AND priced.delivery_status IN ('sent','delivered','read')
    -- An overlapping later ad may open its OWN free window. A message in
    -- that newer window is not independent proof that the old window lasted
    -- beyond 72 hours. Conservatively exclude all such re-entry evidence.
    AND NOT EXISTS (
      SELECT 1 FROM whatsapp_free_entry_referrals newer
      JOIN messages newer_inbound ON newer_inbound.id=newer.origin_message_id
        AND newer_inbound.contact_id=ad.contact_id
        AND newer_inbound.role='user'
      JOIN LATERAL (
        SELECT newer_reply.whatsapp_message_id,newer_reply.created_at
        FROM messages newer_reply
        WHERE newer_reply.contact_id=ad.contact_id
          AND newer_reply.role='assistant'
          AND newer_reply.whatsapp_message_id IS NOT NULL
          AND newer_reply.created_at>=newer_inbound.created_at
          AND newer_reply.created_at<newer_inbound.created_at+interval '24 hours'
        ORDER BY newer_reply.created_at,newer_reply.id LIMIT 1
      ) new_open ON true
      JOIN whatsapp_free_entry_pricing_evidence new_pricing
        ON new_pricing.wamid=new_open.whatsapp_message_id
        AND new_pricing.pricing_type='free_entry_point'
        AND new_pricing.billable=false
      WHERE newer.contact_id=ad.contact_id
        AND newer.source_type='ad'
        AND newer.origin_message_id<>ad.origin_message_id
        AND new_open.created_at>opened.created_at
        AND new_open.created_at<=observed.created_at
    )
    WHERE ad.source_type='ad'
      AND opened.created_at>=TIMESTAMPTZ '2026-09-28 00:00:00+00'
      AND (ad.ctwa_clid IS NOT NULL OR ad.meta_ad_id IS NOT NULL)
  ) AS verified
`;

function settings() {
  return clinicConfig.automatedFollowUp?.whatsappFreeOnly || {};
}
function enabled() { return settings().enabled === true; }
function allow24hServiceReplies() { return enabled() && settings().allow24hServiceReplies === true; }

// A separate, deliberately potentially paid lane for direct text replies.
// A unique pre-send record prevents retries of an ambiguous provider request.
async function reserve24hServiceReply(to,{database=pool,now=new Date(),context={}}={}) {
  if (!allow24hServiceReplies() || context.messageKind !== "first_reply_text" ||
      context.currentFollowUpAttemptId != null) return null;
  const messageId=Number(context.currentMessageId);
  const recipient=String(to||"").replace(/\D/g,"");
  const stamp=new Date(now);
  if (!Number.isSafeInteger(messageId) || messageId<=0 || recipient.length<8 ||
      !Number.isFinite(stamp.getTime())) return null;
  const result=await database.query(`
    INSERT INTO whatsapp_24h_service_reply_exceptions(message_id,contact_id,allowed_at)
    SELECT m.id,c.id,$3::timestamptz
    FROM messages m JOIN contacts c ON c.id=m.contact_id
    WHERE m.id=$1 AND m.role='assistant' AND c.channel='whatsapp'
      AND regexp_replace(c.whatsapp_number,'[^0-9]','','g')=$2
      AND m.whatsapp_message_id IS NULL AND m.whatsapp_template IS NULL
      AND m.is_automated_follow_up IS NOT TRUE
      AND m.automated_follow_up_step IS NULL
      AND m.automated_follow_up_parent_message_id IS NULL
      AND m.pricing_reminder_anchor_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM whatsapp_free_entry_followup_attempts a
                     WHERE a.message_id=m.id)
      AND EXISTS (
        SELECT 1 FROM messages inbound WHERE inbound.contact_id=c.id
          AND inbound.role='user' AND inbound.whatsapp_message_id IS NOT NULL
          AND inbound.created_at<=$3::timestamptz
          AND inbound.created_at>$3::timestamptz-interval '23 hours 58 minutes'
          AND inbound.created_at<=m.created_at
      )
    ON CONFLICT(message_id) DO NOTHING RETURNING message_id
  `,[messageId,recipient,stamp.toISOString()]);
  if (Number(result.rows?.[0]?.message_id)===messageId)
    return {allowed:true,reservationId:null,serviceReplyMessageId:messageId};
  // A prior service send may have reached Meta even if its WAMID never made
  // it back to us. Never fall through to the independent CTWA gate and replay
  // that same saved message after ON CONFLICT suppressed this attempt.
  const prior=await database.query(`
    SELECT 1 FROM whatsapp_24h_service_reply_exceptions
    WHERE message_id=$1 LIMIT 1
  `,[messageId]);
  return prior.rows?.length
    ? deny("zero_cost_service_reply_already_attempted",
      "This service reply was already attempted. Check the original delivery before sending again.")
    : null;
}
async function complete24hServiceReply(messageId,result,database=pool) {
  const accepted=result?.success === true && typeof result.wamid==="string" && !!result.wamid;
  try {
    await database.query(`
      UPDATE whatsapp_24h_service_reply_exceptions
      SET status=$2, wamid=CASE WHEN $2='accepted' THEN $3 ELSE NULL END,
          updated_at=now()
      WHERE message_id=$1 AND status='reserved'
    `,[messageId,accepted?"accepted":"unknown",accepted?result.wamid:null]);
    if (accepted) await database.query(`
      DELETE FROM whatsapp_free_only_billing_alerts
      WHERE wamid=$1 AND sent_at IS NULL
        AND EXISTS(SELECT 1 FROM whatsapp_24h_service_reply_exceptions
                   WHERE wamid=$1 AND status='accepted')
    `,[result.wamid]);
  } catch(error) {
    // After provider acceptance, failing to record proof can only leave
    // the strict template gate more conservative, never more permissive.
    console.error("[WhatsApp 24h service] Failed to record provider result:",error);
  }
}

function deny(code, message) { return { allowed: false, code, message }; }
function blockedResult(check) {
  return {
    success: false, wamid: null, externalMessageId: null,
    policyBlocked: true, policyCode: check.code,
    error: check.message, retryable: false,
  };
}
function configuredAccount() {
  return String(process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
}

// One authoritative ceiling decision for the strict dispatch guard, the
// candidate scheduler, and Tools. Do not schedule a post-72h message merely
// because the deployment flag is set; the dispatch guard would reject it and
// permanently consume a claimed follow-up slot.
//
// Independent evidence can be recorded by a verified post-72h FEP callback
// from a different preexisting, non-strict session. NEVER send a new message
// under strict mode merely to bootstrap this evidence.
async function authorizedCeilingHours({ database = pool, env = process.env } = {}) {
  if (String(env.WHATSAPP_FEP_7DAY_VERIFIED || "").toLowerCase() !== "true") {
    return 72;
  }
  if (!enabled()) return 168;
  const query = typeof database?.query === "function"
    ? database.query.bind(database) : null;
  if (!query) throw new Error("WhatsApp free-only pricing database unavailable");
  const result = await query(SEVEN_DAY_PROOF_SQL);
  return result.rows?.[0]?.verified === true ? 168 : 72;
}

async function logBlock(account, check, database = pool) {
  if (!account || !check?.code) return;
  try {
    await database.query(
      `INSERT INTO whatsapp_free_only_block_events
       (phone_number_id,reason,hour_bucket)
       VALUES ($1,$2,date_trunc('hour',now()))
       ON CONFLICT (phone_number_id,reason,hour_bucket)
       DO UPDATE SET count=whatsapp_free_only_block_events.count+1,
                     last_at=now()`,
      [account,check.code]
    );
  } catch (error) {
    console.error("[WhatsApp free-only] Could not record a blocked send:", error);
  }
}

// Read-only scheduler preflight. Deliberately does not reserve or mark a slot
// consumed. The final provider send must still call reserve() because a Meta
// callback or another worker can change state immediately after this check.
async function preflightTemplate(to, { database = pool, now = new Date(), kind = 'template' } = {}) {
  if (!enabled()) return { allowed: true };
  const account=configuredAccount();
  const recipient=String(to || "").replace(/\D/g,"");
  const cfg=settings();
  const activation=typeof cfg.activatedAt === "string" ? Date.parse(cfg.activatedAt) : NaN;
  const stamp=new Date(now);
  if (!account || recipient.length<8 || !Number.isFinite(activation) ||
      !Number.isFinite(stamp.getTime())) {
    return deny("zero_cost_configuration_invalid","Strict WhatsApp billing preflight configuration is invalid.");
  }
  try {
    const gate=await database.query(
      `SELECT status,wamid FROM whatsapp_free_only_send_gate WHERE phone_number_id=$1`,[account]);
    const previous=gate.rows?.[0];
    if (previous && previous.status!=="idle") {
      // The final reservation performs the actual locked transition from
      // awaiting_pricing to idle. Read-only preflight must not permanently
      // starve followups once the earlier callback has confirmed free billing.
      let reconciled=false;
      if (previous.status==="awaiting_pricing" && previous.wamid) {
        const priced=(await database.query(
          `SELECT pricing_type,billable,delivery_status
             FROM whatsapp_free_entry_pricing_evidence WHERE wamid=$1`,
          [previous.wamid])).rows?.[0];
        reconciled=priced?.pricing_type==="free_entry_point" &&
          priced.billable===false &&
          ["sent","delivered","read"].includes(priced.delivery_status);
      }
      if (!reconciled)
        return deny("zero_cost_previous_send_unreconciled",
          "An earlier WhatsApp send has not finished pricing verification.");
    }
    const billed=await database.query(
      `SELECT EXISTS(SELECT 1 FROM whatsapp_free_entry_pricing_evidence
        WHERE billable=true AND updated_at>=$1::timestamptz
          AND NOT EXISTS(SELECT 1 FROM whatsapp_24h_service_reply_exceptions ex
                         WHERE ex.wamid=whatsapp_free_entry_pricing_evidence.wamid
                           AND ex.status='accepted')) AS tripped`,
      [new Date(activation).toISOString()]);
    if (billed.rows?.[0]?.tripped!==false)
      return deny("zero_cost_billing_alarm","Meta reported a billable message after activation.");
    const ceiling=await authorizedCeilingHours({ database });
    const eligible=await database.query(VERIFIED_WINDOW_SQL,
      [ceiling,stamp.toISOString(),recipient,null,null,kind === "freeform" ? "freeform" : "template"]);
    if (eligible.rows?.[0]?.eligible!==true)
      return deny("zero_cost_unverified_free_entry",kind === "freeform"
        ? "No active, fully proven free-entry free-form window."
        : "No active, fully proven free-entry template window.");
    return {allowed:true};
  } catch(error) {
    console.error("[WhatsApp free-only] Template preflight failed:",error);
    return deny("zero_cost_database_unavailable","WhatsApp pricing evidence cannot be verified.");
  }
}

// Optional ordinary media must satisfy the FREEFORM window, never the
// separately authorized template-only window beyond 24 hours.
async function preflightFreeform(to, options = {}) {
  return preflightTemplate(to, { ...options, kind: 'freeform' });
}

// Read-only signal for the Inbox. This is not a Meta price quote or permission
// to send. Reuse the strict preflight when enabled, and otherwise require the
// same verified CTWA/FEP receipts with the conservative expiry buffer.
async function hasVerifiedFreeTemplateWindow(to, {
  database = pool, now = new Date(), env = process.env,
} = {}) {
  if (enabled()) {
    return (await preflightTemplate(to, { database, now })).allowed === true;
  }
  const recipient = String(to || "").replace(/\D/g, "");
  const stamp = new Date(now);
  if (recipient.length < 8 || !Number.isFinite(stamp.getTime())) return false;
  try {
    let ceiling = 72;
    if (String(env.WHATSAPP_FEP_7DAY_VERIFIED || "").toLowerCase() === "true") {
      const proof = await database.query(SEVEN_DAY_PROOF_SQL);
      if (proof.rows?.[0]?.verified === true) ceiling = 168;
    }
    const result = await database.query(VERIFIED_WINDOW_SQL,
      [ceiling, stamp.toISOString(), recipient, null, null, "template"]);
    return result.rows?.[0]?.eligible === true;
  } catch (error) {
    console.warn("[WhatsApp free-only] Inbox preview could not be verified:", error?.message);
    return false;
  }
}

// Display status is not a dispatch verdict. Strict-mode gate holds, unresolved
// previous sends and billing alarms must never erase valid CTWA window evidence.
async function inspectFreeTemplateWindow(to, {
  database = pool, now = new Date(), env = process.env,
} = {}) {
  const result = { verified: false, sendReady: false, blockedReason: null };
  const recipient = String(to || "").replace(/\D/g, "");
  const stamp = new Date(now);
  if (recipient.length < 8 || !Number.isFinite(stamp.getTime())) return result;
  try {
    let ceiling = 72;
    if (String(env.WHATSAPP_FEP_7DAY_VERIFIED || "").toLowerCase() === "true") {
      const proof = await database.query(SEVEN_DAY_PROOF_SQL);
      if (proof.rows?.[0]?.verified === true) ceiling = 168;
    }
    const verified = await database.query(VERIFIED_SESSION_WINDOW_SQL,
      [ceiling, stamp.toISOString(), recipient]);
    if (verified.rows?.[0]?.verified !== true) return result;

    let ready;
    if (enabled()) {
      ready = await preflightTemplate(to, { database, now });
    } else {
      const send = await database.query(VERIFIED_WINDOW_SQL,
        [ceiling, stamp.toISOString(), recipient, null, null, "template"]);
      ready = send.rows?.[0]?.eligible === true
        ? { allowed: true }
        : { allowed: false, code: "unresolved_pricing" };
    }
    return {
      verified: true,
      sendReady: ready.allowed === true,
      blockedReason: ready.allowed === true ? null : (ready.code || "sending_paused"),
    };
  } catch (error) {
    console.warn("[WhatsApp free-entry] Preview unavailable:", error?.message);
    return result;
  }
}

async function reserve(to, { database = pool, now = new Date(), context = {} } = {}) {
  if (!enabled()) return { allowed: true, reservationId: null };
  if (allow24hServiceReplies() && context.messageKind === "first_reply_text") {
    try {
      const permission=await reserve24hServiceReply(to,{database,now,context});
      if (permission) return permission;
    } catch(error) {
      console.error("[WhatsApp 24h service] Authorization failed:",error);
      return deny("zero_cost_database_unavailable",
        "24-hour customer reply verification is unavailable.");
    }
  }
  const account = configuredAccount();
  const recipient = String(to || "").replace(/\D/g,"");
  const config = settings();
  const activation = typeof config.activatedAt === "string" && config.activatedAt.trim()
    ? Date.parse(config.activatedAt) : NaN;
  const clock = new Date(now);
  if (!account || !recipient || recipient.length<8 ||
      !Number.isFinite(activation) || !Number.isFinite(clock.getTime())) {
    const rejected = deny("zero_cost_configuration_invalid",
      "WhatsApp free-only blocked: account, recipient or activation was not verifiable.");
    await logBlock(account,rejected,database);
    return rejected;
  }

  let client;
  let transaction = false;
  let rejected = null;
  try {
    client = await database.connect();
    await client.query("BEGIN");
    transaction = true;

    // The same account has exactly one locked row. FOR UPDATE serializes
    // reservations across Render workers without keeping a DB connection
    // checked out while Meta handles the HTTP request.
    await client.query(
      `INSERT INTO whatsapp_free_only_send_gate(phone_number_id)
       VALUES($1) ON CONFLICT DO NOTHING`, [account]);
    const gate = (await client.query(
      `SELECT * FROM whatsapp_free_only_send_gate
       WHERE phone_number_id=$1 FOR UPDATE`, [account])).rows[0];

    // After an interrupted Render process, a dead reservation has no
    // provider WAMID. Never release it automatically. Once sufficiently old
    // to exceed the provider HTTP deadline many times over, mark it UNKNOWN
    // for audited operator investigation; this request still fails closed.
    if (gate.status === "reserved" &&
        new Date(gate.updated_at).getTime() <= Date.now() - 15 * 60 * 1000) {
      await client.query(
        `UPDATE whatsapp_free_only_send_gate
           SET status='unknown',updated_at=now()
         WHERE phone_number_id=$1 AND reservation_id=$2 AND status='reserved'`,
        [account,gate.reservation_id]
      );
      gate.status="unknown";
    }

    if (gate.status !== "idle") {
      // The existing reservation row is locked by this transaction. Reuse the
      // same evidence-backed, audited release used by webhook recovery rather
      // than bypassing its reservation and account-wide billing checks.
      const released = gate.status === "awaiting_pricing" && gate.wamid
        ? await reconcileConfirmedGate(client)
        : false;
      if (!released) {
        rejected=deny("zero_cost_previous_send_unreconciled",
          "WhatsApp free-only blocked: another send is awaiting Meta's confirmed free billing.");
      }
    }

    if (!rejected) {
      const alarm=(await client.query(
        `SELECT EXISTS(SELECT 1 FROM whatsapp_free_entry_pricing_evidence
          WHERE billable=true AND updated_at>=$1::timestamptz
          AND NOT EXISTS(SELECT 1 FROM whatsapp_24h_service_reply_exceptions ex
                         WHERE ex.wamid=whatsapp_free_entry_pricing_evidence.wamid
                           AND ex.status='accepted')) AS tripped`,
        [new Date(activation).toISOString()])).rows[0];
      if (alarm?.tripped!==false) {
        rejected=deny("zero_cost_billing_alarm",
          "WhatsApp free-only stopped: Meta reported a billable message after activation.");
      }
    }

    let ceiling=72;
    if (!rejected) ceiling=await authorizedCeilingHours({ database: client });

    // Exclusions may refer ONLY to the exact saved outbound message and
    // claimed follow-up belonging to this recipient. Never trust unverified
    // IDs as a reason to disregard an unresolved message or another worker.
    let currentMessageId = null;
    let currentAttemptId = null;
    if (!rejected && (context.currentMessageId != null ||
                      context.currentFollowUpAttemptId != null)) {
      const messageId = Number(context.currentMessageId);
      const attemptId = context.currentFollowUpAttemptId == null
        ? null : Number(context.currentFollowUpAttemptId);
      if (!Number.isSafeInteger(messageId) || messageId <= 0 ||
          (attemptId != null && (!Number.isSafeInteger(attemptId) || attemptId <= 0))) {
        rejected=deny("zero_cost_invalid_send_context",
          "WhatsApp free-only blocked: current outbound identity is invalid.");
      } else {
        const owned=await client.query(
          `SELECT m.id FROM messages m JOIN contacts c ON c.id=m.contact_id
           WHERE m.id=$1 AND m.role='assistant'
             AND regexp_replace(c.whatsapp_number,'[^0-9]','','g')=$2
             AND m.whatsapp_message_id IS NULL
             AND ($3::bigint IS NULL OR EXISTS (
               SELECT 1 FROM whatsapp_free_entry_followup_attempts a
               WHERE a.id=$3 AND a.message_id=m.id
                 AND a.contact_id=m.contact_id AND a.status='sending'))`,
          [messageId,recipient,attemptId]);
        if (owned.rows.length !== 1) {
          rejected=deny("zero_cost_invalid_send_context",
            "WhatsApp free-only blocked: the current message or attempt does not match the recipient.");
        } else {
          currentMessageId=messageId;
          currentAttemptId=attemptId;
        }
      }
    }

    if (!rejected) {
      const eligible=(await client.query(VERIFIED_WINDOW_SQL,
        [ceiling,clock.toISOString(),recipient,currentMessageId,currentAttemptId,
          context.messageKind === "template" ? "template" : "freeform"])).rows[0];
      if (eligible?.eligible!==true) {
        // The ONLY exception to preexisting FEP pricing proof: one first
        // free-form text reply that opens the entry point for a verified ad.
        // It cannot be used by templates, media, direct/organic enquiries,
        // or sends that lack their own saved outbound message ID.
        let initialEligible=false;
        if (context.messageKind === "first_reply_text" &&
            currentMessageId != null && currentAttemptId == null) {
          const first=(await client.query(CTWA_FIRST_REPLY_SQL,
            [clock.toISOString(),recipient,currentMessageId])).rows[0];
          initialEligible=first?.eligible_first_reply===true;
        }
        if (!initialEligible) {
          rejected=deny("zero_cost_unverified_free_entry",
            "WhatsApp free-only blocked: no verified free-entry period or qualifying first reply from a real Click-to-WhatsApp ad. Unverified templates, media and organic leads remain blocked.");
        }
      }
    }

    let reservationId=null;
    if (!rejected) {
      reservationId=crypto.randomUUID();
      await client.query(
        `UPDATE whatsapp_free_only_send_gate
         SET status='reserved',reservation_id=$2,wamid=NULL,recipient=$3,
             message_id=$4,attempt_id=$5,updated_at=now()
         WHERE phone_number_id=$1`,[account,reservationId,recipient,currentMessageId,currentAttemptId]);
    }
    await client.query("COMMIT");
    transaction=false;
    // Release the scoped connection before a best-effort audit write; a
    // single-connection pool must not deadlock on its own blocked-send log.
    await client.release();
    client=null;
    if (rejected) {
      await logBlock(account,rejected,database);
      return rejected;
    }
    return { allowed:true,reservationId };
  } catch(error) {
    console.error("[WhatsApp free-only] Cannot reserve safe WhatsApp outbound:",error);
    if (transaction && client) await client.query("ROLLBACK").catch(()=>{});
    const rejectedError=deny("zero_cost_database_unavailable",
      "WhatsApp free-only blocked: account-wide billing protection could not be verified.");
    await logBlock(account,rejectedError,database);
    return rejectedError;
  } finally {
    if (client) await client.release();
  }
}

// A confirmed non-2xx 4xx response cannot have created a Meta message. Do
// NOT automatically clear reservations for timeouts, missing WAMIDs or 5xx.
function definitelyRejected(result) {
  return result?.policyBlocked===true ||
    (result?.success===false &&
      Number(result.providerStatus)>=400 && Number(result.providerStatus)<500) ||
    result?.providerRejected===true;
}

async function complete(reservationId,result, database=pool) {
  if (!reservationId) return;
  const account=configuredAccount();
  try {
    if (result?.success===true && result.wamid) {
      await database.query(
        `UPDATE whatsapp_free_only_send_gate SET status='awaiting_pricing',
           wamid=$3,updated_at=now()
         WHERE phone_number_id=$1 AND reservation_id=$2`,
        [account,reservationId,result.wamid]);
      // A confirmed pricing webhook may have arrived before local finalization.
      // Release only verified nonbillable reservations; never wait for this
      // best-effort housekeeping query before returning provider acceptance.
      Promise.resolve().then(() => reconcileConfirmedGate(database))
        .catch((error) => console.error(
          "[WhatsApp free-only] Deferred gate reconciliation failed:", error));
    } else if (definitelyRejected(result)) {
      await database.query(
        `UPDATE whatsapp_free_only_send_gate SET status='idle',
           reservation_id=NULL,wamid=NULL,recipient=NULL,
           message_id=NULL,attempt_id=NULL,updated_at=now()
         WHERE phone_number_id=$1 AND reservation_id=$2`,
        [account,reservationId]);
    } else {
      await database.query(
        `UPDATE whatsapp_free_only_send_gate SET status='unknown',
           updated_at=now()
         WHERE phone_number_id=$1 AND reservation_id=$2`,
        [account,reservationId]);
    }
  } catch(error) {
    // A failed finalization must NEVER open the next slot; the original
    // 'reserved' row remains and stops other outbound requests.
    console.error("[WhatsApp free-only] Send reservation requires reconciliation:",error);
  }
}

// Reconcile only a provider-confirmed, nonbillable reservation. A timeout,
// missing receipt, billed message, or UNKNOWN reservation must stay blocked.
// Never depend on messages.whatsapp_message_id being committed here: Meta can
// deliver the pricing webhook before local outbound persistence finishes.
// The gate's WAMID originates from a provider-accepted reservation, so joining
// it to Meta's durable pricing evidence is the authoritative billing proof.
// Re-running this query is safe across duplicate Meta webhooks and restarts.
async function reconcileConfirmedGate(database = pool) {
  if (!enabled()) return false;
  const account = configuredAccount();
  const activatedAt = Date.parse(settings()?.activatedAt || "");
  if (!account || !Number.isFinite(activatedAt)) return false;
  const proof = await database.query(`
    WITH confirmed AS (
      SELECT g.phone_number_id, g.reservation_id, g.status AS prior_status,
             g.wamid, g.message_id, g.attempt_id, e.pricing_type, e.billable
        FROM whatsapp_free_only_send_gate g
        JOIN whatsapp_free_entry_pricing_evidence e ON e.wamid = g.wamid
       WHERE g.phone_number_id = $1 AND g.status = 'awaiting_pricing'
         AND g.reservation_id IS NOT NULL
         AND e.pricing_type = 'free_entry_point' AND e.billable = false
         AND e.delivery_status IN ('sent','delivered','read')
         AND NOT EXISTS (
           SELECT 1 FROM whatsapp_free_entry_pricing_evidence alarm
            WHERE alarm.billable = true AND alarm.updated_at >= $2::timestamptz
              AND NOT EXISTS(SELECT 1 FROM whatsapp_24h_service_reply_exceptions ex
                             WHERE ex.wamid=alarm.wamid AND ex.status='accepted')
         )
       FOR UPDATE OF g
    ), released AS (
      UPDATE whatsapp_free_only_send_gate g
         SET status = 'idle', reservation_id = NULL, wamid = NULL,
             recipient = NULL, message_id = NULL, attempt_id = NULL,
             updated_at = now()
        FROM confirmed c
       WHERE g.phone_number_id = c.phone_number_id
         AND g.status = c.prior_status AND g.wamid = c.wamid
         AND g.reservation_id IS NOT DISTINCT FROM c.reservation_id
      RETURNING c.*
    ), audit AS (
      INSERT INTO whatsapp_free_only_reconciliations (
        phone_number_id, reservation_id, prior_status, wamid,
        message_id, attempt_id, actor, reason, verified_billing_hub,
        provider_pricing_type, provider_billable, reconciled_at
      )
      SELECT phone_number_id, reservation_id, prior_status, wamid,
             message_id, attempt_id, 'automatic_verified_receipt',
             'Automated Meta provider receipt; NOT manual Billing Hub inspection',
             false, pricing_type, billable, now()
        FROM released
      RETURNING id
    )
    SELECT count(*)::integer AS released FROM audit
  `, [account, new Date(activatedAt).toISOString()]);
  return Number(proof.rows?.[0]?.released || 0) > 0;
}

async function perform(to, operation, context = {}) {
  const check=await reserve(to,{ context });
  if (!check.allowed) return blockedResult(check);
  let result;
  try {
    result=await operation();
  } catch (error) {
    if (check.serviceReplyMessageId) await complete24hServiceReply(check.serviceReplyMessageId,{success:false,ambiguous:true});
    else await complete(check.reservationId,{success:false,ambiguous:true});
    throw error;
  }
  if (check.serviceReplyMessageId) await complete24hServiceReply(check.serviceReplyMessageId,result);
  else await complete(check.reservationId,result);
  return result;
}

module.exports = {
  blockedResult,configuredAccount,enabled,settings,allow24hServiceReplies,reserve24hServiceReply,complete24hServiceReply,preflightTemplate,preflightFreeform,hasVerifiedFreeTemplateWindow,inspectFreeTemplateWindow,reserve,complete,reconcileConfirmedGate,perform,
  authorizedCeilingHours,VERIFIED_WINDOW_SQL,VERIFIED_SESSION_WINDOW_SQL,SEVEN_DAY_PROOF_SQL,CTWA_FIRST_REPLY_SQL,
};
