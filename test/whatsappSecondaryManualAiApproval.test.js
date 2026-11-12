"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const contacts = require("../src/db/contactsRepo");

const env = {
  WHATSAPP_SECONDARY_LEGACY_STAFF_MODE_ENABLED: "true",
  WHATSAPP_SECONDARY_LEGACY_STAFF_ACTIVATED_AT: "2026-11-12T02:36:00Z",
  WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE: "all_contacts",
  WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE: "all_contacts",
  WHATSAPP_SECONDARY_AI_SEND_ENABLED: "true",
  WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED: "true",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID: "secondary-phone",
  WHATSAPP_SECONDARY_WABA_ID: "secondary-waba",
};

test("legacy secondary approval fails closed when the rollout is off", async () => {
  assert.equal(await contacts.approveSecondaryManualAi(9012, "admin", "2026-11-12T08:23:32.033Z", {}), null);
});

test("approval SQL requires connected sender, AI ownership, opt-out and review safeguards", async () => {
  let calls = 0;
  const database = { query: async (sql, args) => {
    calls++;
    for (const required of [
      "c.mode = 'ai'",
      "c.needs_attention IS NOT TRUE",
      "c.whatsapp_opt_out_at IS NULL",
      "review.status = 'pending'",
      "sa.sender_key = 'neutro_secondary'",
      "sa.state = 'active'",
      "sa.coexistence_enabled = TRUE",
      "sa.meta_phone_number_id = $2",
      "sa.meta_account_id = $3",
      "sc.state = 'bound'",
      "date_trunc('milliseconds', c.updated_at) = $5::timestamptz",
      "INTERVAL '7 days'",
    ]) assert.ok(sql.includes(required), "missing safeguard: " + required);
    assert.deepEqual(args, [9012, "secondary-phone", "secondary-waba", "admin", "2026-11-12T08:23:32.033Z"]);
    return { rows: [] };
  }};
  assert.equal(await contacts.approveSecondaryManualAi(
    9012, "admin", "2026-11-12T08:23:32.033Z", env, database
  ), null);
  assert.equal(calls, 1);
});
