"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../src/services/whatsappSecondaryPolicyService");

const NOW = new Date("2026-10-22T08:00:00Z");
const env = {
  WHATSAPP_MULTI_NUMBER_READ_ENABLED: "true",
  WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED: "true",
  WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED: "true",
  WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED: "true",
  WHATSAPP_PHONE_NUMBER_ID: "100100100",
  WHATSAPP_WABA_ID: "200200200",
  WHATSAPP_PRIMARY_SENDER_KEY: "neutro",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID: "300300300",
  WHATSAPP_SECONDARY_WABA_ID: "400400400",
  WHATSAPP_SECONDARY_SENDER_KEY: "ariel",
  WHATSAPP_SECONDARY_TOKEN: "secondary-secret",
  WHATSAPP_TOKEN: "primary-secret",
};
const contact = {
  id: 52, channel: "whatsapp", whatsapp_number: "60125550000",
};
function row(overrides = {}) {
  return {
    id: 52, channel: "whatsapp", whatsapp_number: contact.whatsapp_number,
    whatsapp_sender_id: "2",
    whatsapp_opt_in_at: "2026-10-20T04:00:00Z",
    whatsapp_opt_in_source: "explicit_customer_message",
    whatsapp_opt_out_at: null, whatsapp_marketing_opt_out_at: null,
    sender_conversation_id: "75", binding_state: "bound",
    customer_wa_id: contact.whatsapp_number, sender_key: "ariel",
    meta_phone_number_id: env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
    meta_account_id: env.WHATSAPP_SECONDARY_WABA_ID,
    sender_state: "active", latest_inbound_at: "2026-10-22T07:45:00Z",
    ...overrides,
  };
}
function database(state = row(), { marketing = null, ctwa = null, capture = null } = {}) {
  return {
    async query(sql, args) {
      capture?.push({ sql, args });
      if (sql.includes("MAX(COALESCE(m.source_created_at")) {
        return { rows: state ? [state] : [] };
      }
      if (sql.includes("whatsapp_marketing_consent_events e")) {
        return { rows: marketing ? [marketing] : [] };
      }
      if (sql.includes("whatsapp_free_entry_referrals entry")) {
        return { rows: [{ verified: ctwa === true }] };
      }
      throw new Error("Unexpected database query");
    },
  };
}
function approvedFetch(calls, result) {
  return async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({
      data: [result || { name: "ariel_reminder", language: "en_US",
        status: "APPROVED", category: "UTILITY" }],
    }) };
  };
}

test("secondary service policy is default-off and cannot authorize API sending", async () => {
  const result = await policy.previewSecondaryFreeformPolicy(contact, {
    env: { ...env, WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED: "false" },
    database: database(), now: NOW,
  });
  assert.equal(result.code, "secondary_policy_disabled");
  const ready = await policy.previewSecondaryFreeformPolicy(contact, {
    env, database: database(), now: NOW,
  });
  assert.equal(ready.policyAllowed, true);
  assert.equal(ready.sendAuthorized, false);
  assert.match(ready.windowEndsAt, /2026-10-23T07:45/);
});

test("sender binding query requires exact contact, sender key, phone and account", async () => {
  const calls = [];
  const result = await policy.previewSecondaryFreeformPolicy(contact, {
    env, database: database(row(), { capture: calls }), now: NOW,
  });
  assert.equal(result.policyAllowed, true);
  assert.deepEqual(calls[0].args, [
    52, contact.whatsapp_number, "ariel", "300300300", "400400400",
  ]);
  assert.match(calls[0].sql, /mc\.conversation_id=sc\.id/);
  assert.match(calls[0].sql, /sa\.meta_phone_number_id=\$4/);
  assert.match(calls[0].sql, /sa\.meta_account_id=\$5/);
});

test("a Neutro contact, disabled Ariel or conflicting caller-supplied number cannot authorize policy", async () => {
  for (const state of [
    null,
    row({ sender_key: "neutro" }),
    row({ meta_phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID }),
    row({ meta_account_id: env.WHATSAPP_WABA_ID }),
    row({ binding_state: "pending" }),
    row({ sender_state: "disabled" }),
    row({ customer_wa_id: "60121111111" }),
    row({ whatsapp_number: "60121111111" }),
  ]) {
    const result = await policy.previewSecondaryFreeformPolicy(contact, {
      env, database: database(state), now: NOW,
    });
    assert.equal(result.policyAllowed, false, JSON.stringify(state));
    assert.equal(result.sendAuthorized, false);
  }
  const mismatch = await policy.previewSecondaryFreeformPolicy({
    ...contact, whatsapp_sender_phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID,
  }, { env, database: database(), now: NOW });
  assert.equal(mismatch.code, "secondary_sender_mismatch");
});

test("secondary reply window does not borrow a different sender's inbound messages", async () => {
  for (const [state, code] of [
    [row({ latest_inbound_at: null }), "secondary_no_verified_inbound"],
    [row({ latest_inbound_at: "2026-10-21T07:00:00Z" }), "secondary_service_window_closed"],
    [row({ latest_inbound_at: "2026-10-22T08:10:00Z" }), "secondary_no_verified_inbound"],
    [row({ whatsapp_opt_out_at: "2026-10-22T07:50:00Z" }), "secondary_opted_out"],
  ]) {
    const answer = await policy.previewSecondaryFreeformPolicy(contact, {
      env, database: database(state), now: NOW,
    });
    assert.equal(answer.code, code);
  }
  assert.equal((await policy.previewSecondaryFreeformPolicy(contact, {
    env, database: database(), purpose: "marketing", now: NOW,
  })).code, "secondary_marketing_requires_template");
  assert.equal((await policy.previewSecondaryFreeformPolicy(contact, {
    env, database: database(row({
      whatsapp_opt_out_at: "2026-10-22T07:00:00Z",
    })), now: NOW,
  })).policyAllowed, true, "a new verified inbound after global STOP can reopen service only");
});

test("utility templates need Ariel catalog approval and explicit contact opt-in", async () => {
  const calls = [];
  const answer = await policy.previewSecondaryTemplatePolicy(contact, {
    env, database: database(), fetchImpl: approvedFetch(calls),
    name: "ariel_reminder", languageCode: "en_US", now: NOW,
  });
  assert.equal(answer.policyAllowed, true);
  assert.equal(answer.sendAuthorized, false);
  assert.equal(answer.template.category, "UTILITY");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/400400400\/message_templates/);
  assert.equal(calls[0].options.headers.Authorization, "Bearer secondary-secret");
  const blocked = await policy.previewSecondaryTemplatePolicy(contact, {
    env, database: database(row({ whatsapp_opt_in_at: null })),
    fetchImpl: approvedFetch([]), name: "ariel_reminder", languageCode: "en_US", now: NOW,
  });
  assert.equal(blocked.code, "secondary_missing_opt_in");
});

test("templates are rejected on wrong approval, wrong language, missing catalog or pagination", async () => {
  for (const [record, code] of [
    [{ name: "neutro_only", language: "en_US", status: "APPROVED", category: "UTILITY" },
      "secondary_template_not_approved"],
    [{ name: "ariel_reminder", language: "en_US", status: "PENDING", category: "UTILITY" },
      "secondary_template_not_approved"],
  ]) {
    const answer = await policy.previewSecondaryTemplatePolicy(contact, {
      env, database: database(), fetchImpl: approvedFetch([], record),
      name: "ariel_reminder", languageCode: "en_US", now: NOW,
    });
    assert.equal(answer.code, code);
  }
  const paged = await policy.previewSecondaryTemplatePolicy(contact, {
    env, database: database(), fetchImpl: async () => ({
      ok: true, json: async () => ({
        data: [{ name: "ariel_reminder", language: "en_US",
          status: "APPROVED", category: "UTILITY" }],
        paging: { next: "https://graph.facebook.com/page2" },
      }),
    }),
    name: "ariel_reminder", languageCode: "en_US", now: NOW,
  });
  assert.equal(paged.code, "secondary_template_catalog_incomplete");
  const unreachable = await policy.previewSecondaryTemplatePolicy(contact, {
    env, database: database(), fetchImpl: async () => { throw new Error("offline"); },
    name: "ariel_reminder", languageCode: "en_US", now: NOW,
  });
  assert.equal(unreachable.code, "secondary_template_catalog_unavailable");
});

test("marketing consent must be proven for the same sender and treatment", async () => {
  const fetchImpl = approvedFetch([], {
    name: "ariel_offer", language: "en_US", status: "APPROVED", category: "MARKETING",
  });
  const args = { env, name: "ariel_offer", languageCode: "en_US",
    treatmentInterest: "3D", fetchImpl, now: NOW };
  assert.equal((await policy.previewSecondaryTemplatePolicy(contact, {
    ...args, database: database(),
  })).code, "secondary_marketing_consent_unverified");
  assert.equal((await policy.previewSecondaryTemplatePolicy(contact, {
    ...args, database: database(row({
      whatsapp_marketing_opt_out_at: "2026-10-22T06:00:00Z",
    })),
  })).code, "secondary_marketing_opted_out");
  const capture = [];
  const accepted = await policy.previewSecondaryTemplatePolicy(contact, {
    ...args, database: database(row(), {
      marketing: { marketing_consent: "opted_in", verified: true }, capture,
    }),
  });
  assert.equal(accepted.policyAllowed, true);
  assert.equal(accepted.sendAuthorized, false);
  const consentSQL = capture.find(x => x.sql.includes("whatsapp_marketing_consent_events"));
  assert.ok(consentSQL);
  assert.deepEqual(consentSQL.args, [52, "75", "2026-10-20T04:00:00.000Z", "3D"]);
  assert.match(consentSQL.sql, /mc\.conversation_id=\$2/);
});

test("CTWA proof requires exact sender-qualified message context and Meta pricing identity", async () => {
  const capture = [];
  const proof = await policy.inspectSecondaryCtwaEvidence(contact, {
    env, database: database(row(), { ctwa: true, capture }), now: NOW,
  });
  assert.equal(proof.verified, true);
  assert.equal(proof.sendAuthorized, false);
  const sql = capture.find(x => x.sql.includes("whatsapp_free_entry_referrals entry"));
  assert.ok(sql);
  assert.deepEqual(sql.args, [52, "75", "300300300", "400400400", NOW.toISOString()]);
  assert.match(sql.sql, /priced\.business_phone_number_id=\$3/);
  assert.match(sql.sql, /priced\.business_account_id=\$4/);
  assert.match(sql.sql, /inc\.conversation_id=\$2/);
  assert.match(sql.sql, /rmc\.conversation_id=\$2/);
});

test("missing database or wrong explicit environment never permits sender policy", async () => {
  const failed = await policy.previewSecondaryFreeformPolicy(contact, {
    env, database: { query: async () => { throw Error("database down"); } }, now: NOW,
  });
  assert.equal(failed.code, "secondary_policy_database_unavailable");
  for (const override of [
    { WHATSAPP_SECONDARY_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID },
    { WHATSAPP_SECONDARY_SENDER_KEY: env.WHATSAPP_PRIMARY_SENDER_KEY },
  ]) {
    const answer = await policy.previewSecondaryFreeformPolicy(contact, {
      env: { ...env, ...override }, database: database(), now: NOW,
    });
    assert.equal(answer.policyAllowed, false);
  }
});
