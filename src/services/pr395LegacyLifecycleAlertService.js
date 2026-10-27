"use strict";

// Dedicated PR395 staging-only notification worker. It never changes
// Neutro's subscription, sender state or production database.
const { pool } = require("../db/db");
const { isTelegramEnabled, postTelegramMessage } = require("./telegramAlertService");
function enabled(env=process.env) {
  return env.PR395_STAGING_MODE === "true" &&
    env.PR395_STAGING_LEGACY_LIFECYCLE_ENABLED === "true" &&
    env.PR395_STAGING_LEGACY_LIFECYCLE_ALERT_ENABLED === "true" &&
    env.PR395_STAGING_ALLOW_PROVIDER_PROCESSING !== "true" &&
    env.PR395_STAGING_PROVIDER_REHEARSAL_ENABLED !== "true" &&
    /^\d+$/.test(String(env.PR395_STAGING_LEGACY_WABA_ID || "")) &&
    isTelegramEnabled(env);
}
async function runOnce({
  env=process.env, database=pool, post=postTelegramMessage, logger=console
}={}) {
  if (!enabled(env)) return {processed:0,disabled:true};
  // Mark interrupted previous claims UNKNOWN, not silently successful.
  // Manual inspection is required if a Telegram send may have completed.
  await database.query(
    "UPDATE whatsapp_pr395_legacy_lifecycle_alerts " +
    "SET delivery_state='unknown',updated_at=NOW() " +
    "WHERE delivery_state='processing' AND claim_started_at < NOW() - INTERVAL '3 minutes'"
  );
  const claim=await database.query(
    "UPDATE whatsapp_pr395_legacy_lifecycle_alerts SET " +
    "delivery_state='processing',claim_started_at=NOW(),attempts=attempts+1,updated_at=NOW() " +
    "WHERE fingerprint IN (SELECT fingerprint FROM whatsapp_pr395_legacy_lifecycle_alerts " +
    "WHERE delivery_state='pending' AND account_id=$1 ORDER BY updated_at " +
    "FOR UPDATE SKIP LOCKED LIMIT 1) " +
    "RETURNING fingerprint,account_id,event_type,severity",
    [env.PR395_STAGING_LEGACY_WABA_ID]
  );
  const alert=claim.rows?.[0];
  if(!alert)return {processed:0};
  const description=alert.severity==="critical"?
    "Possible Neutro WhatsApp disconnection. STOP QR and Meta callback changes; verify Neutro delivery, subscription and business access without modifying production.":
    "Neutro WhatsApp lifecycle event requires operator review; check signed audit and current Meta subscription.";
  try {
    await post({
      token:env.TELEGRAM_BOT_TOKEN,
      chatId:env.TELEGRAM_CHAT_ID,
      text:"PR395 Neutro lifecycle "+alert.severity.toUpperCase()+
        "\nWABA: "+alert.account_id+
        "\nEvent: "+alert.event_type+
        "\nAudit SHA256: "+alert.fingerprint+
        "\n"+description
    });
    await database.query(
      "UPDATE whatsapp_pr395_legacy_lifecycle_alerts SET " +
      "delivery_state='sent',delivered_at=NOW(),updated_at=NOW() " +
      "WHERE fingerprint=$1 AND delivery_state='processing'",[alert.fingerprint]
    );
    return {processed:1,critical:alert.severity==="critical"};
  } catch (_) {
    // Do not log Telegram token, credentials or payloads. A timeout may
    // mean Telegram delivered. Leave durable UNKNOWN for manual review.
    await database.query(
      "UPDATE whatsapp_pr395_legacy_lifecycle_alerts SET " +
      "delivery_state='unknown',updated_at=NOW() " +
      "WHERE fingerprint=$1 AND delivery_state='processing'",[alert.fingerprint]
    ).catch(()=>{});
    logger.error("[PR395] Neutro lifecycle alert delivery uncertain. Inspect isolated staging audit.");
    return {processed:0,unknown:true};
  }
}
let timer=null;
function start({env=process.env,run=runOnce,setIntervalFn=setInterval}={}) {
  if (!enabled(env) || timer)return false;
  run({env}).catch(()=>console.error("[PR395] Legacy alert worker needs review."));
  timer=setIntervalFn(()=>{
    run({env}).catch(()=>console.error("[PR395] Legacy alert worker needs review."));
  },60000);
  timer.unref?.();
  return true;
}
function stop(){if(timer){clearInterval(timer);timer=null;}}
module.exports={enabled,runOnce,start,stop};
