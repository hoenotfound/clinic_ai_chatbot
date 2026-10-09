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
          -- A prior unresolved message can be set aside only by an audited
          -- operator who checked Meta Billing Hub for that exact send.
          AND NOT EXISTS (
            SELECT 1 FROM whatsapp_free_only_reconciliations audit
            WHERE audit.message_id=earlier.id AND audit.verified_billing_hub=true
          )
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
            WHERE audit.attempt_id=attempt.id AND audit.verified_billing_hub=true
          )
          AND attempt.status IN ('sending','unknown')
      )
  ) AS eligible
`;

// Do NOT interpret an environment flag as seven-day billing proof on its own.
// A post-72h, nonbillable, qualified follow-up from THIS clinic is required.
const SEVEN_DAY_PROOF_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM whatsapp_free_entry_followup_attempts a
    JOIN messages first_reply ON first_reply.id=a.first_reply_message_id
    JOIN whatsapp_free_entry_pricing_evidence p ON p.wamid=a.wamid
    WHERE a.status='accepted' AND a.slot_hours>=73
      AND p.pricing_type='free_entry_point' AND p.billable=false
      AND p.delivery_status IN ('sent','delivered','read')
      AND a.created_at>=first_reply.created_at + interval '72 hours'
      AND a.created_at<first_reply.created_at + interval '168 hours'
  ) AS verified
`;

function settings() {
  return clinicConfig.automatedFollowUp?.whatsappFreeOnly || {};
}
function enabled() { return settings().enabled === true; }
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

async function reserve(to, { database = pool, now = new Date(), context = {} } = {}) {
  if (!enabled()) return { allowed: true, reservationId: null };
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
      if (gate.status === "awaiting_pricing" && gate.wamid) {
        const priced = (await client.query(
          `SELECT pricing_type,billable,delivery_status
           FROM whatsapp_free_entry_pricing_evidence WHERE wamid=$1`,
          [gate.wamid])).rows[0];
        if (priced?.pricing_type==="free_entry_point" && priced.billable===false &&
            ["sent","delivered","read"].includes(priced.delivery_status)) {
          await client.query(
            `UPDATE whatsapp_free_only_send_gate SET status='idle',
               reservation_id=NULL,wamid=NULL,recipient=NULL,
               message_id=NULL,attempt_id=NULL,updated_at=now()
             WHERE phone_number_id=$1`,[account]);
        } else {
          rejected=deny("zero_cost_previous_send_unreconciled",
            "WhatsApp free-only blocked: another message is awaiting Meta's confirmed free billing.");
        }
      } else {
        rejected=deny("zero_cost_previous_send_unreconciled",
          "WhatsApp free-only blocked: a previous or concurrent send has not been reconciled.");
      }
    }

    if (!rejected) {
      const alarm=(await client.query(
        `SELECT EXISTS(SELECT 1 FROM whatsapp_free_entry_pricing_evidence
          WHERE billable=true AND updated_at>=$1::timestamptz) AS tripped`,
        [new Date(activation).toISOString()])).rows[0];
      if (alarm?.tripped!==false) {
        rejected=deny("zero_cost_billing_alarm",
          "WhatsApp free-only stopped: Meta reported a billable message after activation.");
      }
    }

    let ceiling=72;
    if (!rejected && String(process.env.WHATSAPP_FEP_7DAY_VERIFIED).toLowerCase()==="true") {
      const proof=(await client.query(SEVEN_DAY_PROOF_SQL)).rows[0];
      if (proof?.verified===true) ceiling=168;
    }

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
        rejected=deny("zero_cost_unverified_free_entry",
          "WhatsApp free-only blocked: no fully proven, active Meta free-entry period. New ad leads cannot receive a first reply in strict mode.");
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

async function perform(to, operation, context = {}) {
  const check=await reserve(to,{ context });
  if (!check.allowed) return blockedResult(check);
  let result;
  try {
    result=await operation();
  } catch (error) {
    await complete(check.reservationId,{ success:false,ambiguous:true });
    throw error;
  }
  await complete(check.reservationId,result);
  return result;
}

module.exports = {
  blockedResult,configuredAccount,enabled,settings,reserve,complete,perform,
  VERIFIED_WINDOW_SQL,SEVEN_DAY_PROOF_SQL,
};
