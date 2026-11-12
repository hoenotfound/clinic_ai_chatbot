"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { pool } = require("../src/db/db");
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

test("manual approval requires active sender, bound contact, AI ownership and no unresolved reviews", async () => {
  const original = pool.query;
  let called = 0;
  try {
    pool.query = async (sql, args) => {
      called += 1;
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
      ]) assert.ok(sql.includes(required), "missing guard: " + required);
      assert.deepEqual(args, [9012, "secondary-phone", "secondary-waba", "admin", "2026-11-12T08:23:32.033Z"]);
      return { rows: [] };
    };
    assert.equal(await contacts.approveSecondaryManualAi(
      9012, "admin", "2026-11-12T08:23:32.033Z", env
    ), null);
    assert.equal(called, 1);
  } finally {
    pool.query = original;
  }
});
