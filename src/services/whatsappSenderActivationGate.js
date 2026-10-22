"use strict";

// These switches may NOT be enabled piecemeal. The existing single-number
// deployment remains unchanged when sender-scoped ingress is disabled.
function assertSenderIngressSafety(env = process.env) {
  if (env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED !== "true") return;
  if (env.WHATSAPP_MULTI_NUMBER_READ_ENABLED !== "true" ||
      env.WHATSAPP_SINGLE_SENDER_STRICT_METADATA !== "true" ||
      env.WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED !== "true" ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(String(env.WHATSAPP_PRIMARY_SENDER_KEY || "")) ||
      !/^[0-9]+$/.test(String(env.WHATSAPP_PHONE_NUMBER_ID || "")) ||
      !/^[0-9]+$/.test(String(env.WHATSAPP_WABA_ID || ""))) {
    throw new Error("Unsafe WhatsApp sender activation: scoped ingress requires verified " +
      "primary sender key/account/phone and strict Meta metadata/account guards.");
  }
}
// Called after versioned migrations, before workers and readiness go live.
// A former dual-number deployment must never silently revert to a single-
// sender send path while any non-primary conversation remains bound.
async function assertStoredSenderSafety({
  database = require("../db/db").pool,
  env = process.env,
} = {}) {
  assertSenderIngressSafety(env);
  const phone = String(env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  const account = String(env.WHATSAPP_WABA_ID || "").trim();
  const key = String(env.WHATSAPP_PRIMARY_SENDER_KEY || "").trim();
  const readEnabled = env.WHATSAPP_MULTI_NUMBER_READ_ENABLED === "true";
  const ingressEnabled = env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED === "true";
  // Even a flag rollback must inspect durable identity before workers start.
  const scope = await database.query(
    "SELECT COUNT(*)::int AS total, " +
    "COUNT(*) FILTER (WHERE sa.meta_phone_number_id IS DISTINCT FROM $1 " +
    "OR sa.meta_account_id IS DISTINCT FROM $2 " +
    "OR sa.state IS DISTINCT FROM 'active')::int AS nonprimary " +
    "FROM contacts c LEFT JOIN whatsapp_sender_accounts sa " +
    "ON sa.id=c.whatsapp_sender_id " +
    "WHERE c.channel='whatsapp' AND c.whatsapp_sender_id IS NOT NULL",
    [phone, account]
  );
  const total = Number(scope.rows?.[0]?.total);
  const nonprimary = Number(scope.rows?.[0]?.nonprimary);
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(nonprimary)) {
    throw new Error("Cannot verify durable WhatsApp sender bindings at startup.");
  }
  if (!readEnabled && nonprimary > 0) {
    throw new Error("Unsafe WhatsApp rollback: secondary-number contacts remain " +
      "bound; sender-aware reads must stay enabled.");
  }
  if (ingressEnabled) {
    const registered = await database.query(
      "SELECT id, sender_key, state FROM whatsapp_sender_accounts " +
      "WHERE meta_phone_number_id=$1 AND meta_account_id=$2",
      [phone, account]
    );
    const sender = registered.rows?.[0];
    if (!sender || sender.state !== "active" || sender.sender_key !== key) {
      throw new Error("Unsafe WhatsApp activation: primary sender does not " +
        "match an active persisted Neutro account and business phone.");
    }
  }
  return { verified: true, scopedContacts: total, nonprimaryContacts: nonprimary };
}

module.exports = { assertSenderIngressSafety, assertStoredSenderSafety };
