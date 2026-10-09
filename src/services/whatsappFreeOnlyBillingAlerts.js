"use strict";

const { pool } = require("../db/db");
const clinicConfig = require("../config/clinicConfig");
const { isTelegramEnabled, postTelegramMessage } = require("./telegramAlertService");
const { configuredAccount } = require("./whatsappZeroCostGuard");

function activeSince() {
  const config=clinicConfig.automatedFollowUp?.whatsappFreeOnly;
  const parsed=Date.parse(config?.activatedAt || "");
  if (config?.enabled !== true || !Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

async function flush({ database=pool, send=postTelegramMessage, env=process.env }={}) {
  const since=activeSince();
  const account=configuredAccount();
  if (!since || !account || !isTelegramEnabled(env)) return 0;
  const claimed=await database.query(
    `WITH pending AS (
       SELECT wamid FROM whatsapp_free_only_billing_alerts
       WHERE phone_number_id=$1 AND observed_at>=$2::timestamptz
         AND sent_at IS NULL AND
         (lease_until IS NULL OR lease_until<now())
       ORDER BY observed_at ASC LIMIT 5 FOR UPDATE SKIP LOCKED
     )
     UPDATE whatsapp_free_only_billing_alerts alerts
     SET lease_until=now()+interval '2 minutes',
         attempts=attempts+1
     FROM pending WHERE alerts.wamid=pending.wamid
     RETURNING alerts.wamid,alerts.observed_at,alerts.attempts`,
    [account,since]
  );
  let successes=0;
  for (const item of claimed.rows) {
    try {
      await send({
        token:env.TELEGRAM_BOT_TOKEN,chatId:env.TELEGRAM_CHAT_ID,
        text: "🚨 DA Chatbot WhatsApp FREE-ONLY BILLING ALARM\n"+
          "Meta reported a billable WhatsApp message. All strict-mode sends are blocked.\n"+
          "Message: "+String(item.wamid).slice(0,100)+"\n"+
          "Review Meta Billing Hub and Neon evidence before resetting the switch. "+
          "A charge may already have occurred."
      });
      await database.query(
        `UPDATE whatsapp_free_only_billing_alerts
         SET sent_at=now(),lease_until=NULL,last_error=NULL
         WHERE wamid=$1`,[item.wamid]
      );
      successes++;
    } catch(error) {
      // Retry on later recovery runs; never report an alert as delivered
      // merely because an HTTP request to Telegram was attempted.
      await database.query(
        `UPDATE whatsapp_free_only_billing_alerts
         SET lease_until=now()+interval '3 minutes',last_error=$2
         WHERE wamid=$1`,
        [item.wamid,String(error?.message || error).slice(0,500)]
      );
      console.error("[WhatsApp free-only] Billing Telegram alert retry scheduled:",error);
    }
  }
  return successes;
}

// This signal is used by the delivery worker to keep retry cadence short
// whenever an unsent billing alarm exists, even with no new webhooks.
async function pending({ database=pool }={}) {
  const since=activeSince();
  const account=configuredAccount();
  if (!since || !account) return false;
  const r=await database.query(
    `SELECT EXISTS(SELECT 1 FROM whatsapp_free_only_billing_alerts
       WHERE phone_number_id=$1 AND observed_at>=$2::timestamptz
         AND sent_at IS NULL) AS pending`,[account,since]
  );
  return r.rows?.[0]?.pending === true;
}

module.exports={activeSince,flush,pending};
