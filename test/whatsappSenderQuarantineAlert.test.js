"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { partitionSecondaryInboxWebhook } = require("../src/services/whatsappSecondaryInboxBoundary");
const { notifyWhatsAppSenderQuarantine } = require("../src/services/whatsappSenderQuarantineAlert");

const PRIMARY = "100000000000001";
const SECONDARY = "100000000000002";
const PRIMARY_ACCOUNT = "200000000000001";
const SECONDARY_ACCOUNT = "200000000000002";
const router = {
  primaryPhoneId: PRIMARY,
  primaryAccountId: PRIMARY_ACCOUNT,
  secondaryPhoneId: SECONDARY,
  secondaryAccountId: SECONDARY_ACCOUNT,
};
const env = {
  TELEGRAM_ALERTS_ENABLED: "true",
  TELEGRAM_BOT_TOKEN: "unit-test-token",
  TELEGRAM_CHAT_ID: "unit-test-chat",
  WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED: "true",
  WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED: "false",
  WHATSAPP_SECONDARY_WABA_ID: SECONDARY_ACCOUNT,
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID: SECONDARY,
};

function partition(changes) {
  return partitionSecondaryInboxWebhook({
    object: "whatsapp_business_account",
    entry: changes,
  }, router);
}
let nextStatusId = 0;
function secondaryStatus(status = "delivered", errors = undefined) {
  const receipt = { id: "wamid.secondary.status." + (++nextStatusId), status };
  if (errors !== undefined) receipt.errors = errors;
  const result = partition([{
    id: SECONDARY_ACCOUNT,
    changes: [{
      field: "messages",
      value: {
        metadata: { phone_number_id: SECONDARY },
        statuses: [receipt],
      },
    }],
  }]);
  assert.equal(result.acceptedActionable, 0);
  assert.equal(result.quarantined.length, 1);
  return result.quarantined[0];
}
function capture() {
  const messages = [];
  const warnings = [];
  return {
    messages,
    warnings,
    post: async (value) => { messages.push(value.text); },
    logger: {
      warn: (value) => warnings.push(value),
      error: (value) => { throw new Error(value); },
    },
  };
}

test("expected signed secondary status is audited but does not trigger Telegram", async () => {
  const item = secondaryStatus();
  assert.equal(item.expectedSecondaryStatus, true);
  assert.equal(item.reason, "unsupported_whatsapp_event");
  const calls = capture();
  const sent = await notifyWhatsAppSenderQuarantine([item], {
    env, now: 2000000000000, ...calls,
  });
  assert.equal(sent, false);
  assert.deepEqual(calls.messages, []);
  assert.deepEqual(calls.warnings, []);
  // No change to the input that the caller persists in the audit table.
  assert.equal(item.reason, "unsupported_whatsapp_event");
});

test("a foreign routing failure still alerts when mixed with expected statuses", async () => {
  const result = partition([
    {
      id: SECONDARY_ACCOUNT,
      changes: [{ field: "messages", value: {
        metadata: { phone_number_id: SECONDARY },
        statuses: [{ id: "wamid.secondary.status", status: "sent" }],
      } }],
    },
    {
      id: "299999999999999",
      changes: [{ field: "messages", value: {
        metadata: { phone_number_id: "109999999999999" },
        messages: [{ id: "wamid.foreign", from: "60111111111", type: "text" }],
      } }],
    },
  ]);
  assert.equal(result.quarantined.length, 2);
  assert.equal(result.quarantined.filter(item => item.expectedSecondaryStatus).length, 1);
  const serious = result.quarantined.find(item => !item.expectedSecondaryStatus);
  assert.ok(serious);
  const calls = capture();
  const sent = await notifyWhatsAppSenderQuarantine(result.quarantined, {
    env, now: 2000000720000, ...calls,
  });
  assert.equal(sent, true);
  assert.equal(calls.messages.length, 1);
  assert.match(calls.messages[0], /1 callback event\(s\) were isolated/);
  assert.ok(calls.messages[0].includes(serious.reason));
  assert.equal(calls.warnings.length, 1);
  assert.equal(result.quarantined.length, 2);
});

test("sender metadata alone cannot suppress an unmarked unsupported event", async () => {
  const { expectedSecondaryStatus, ...unmarked } = secondaryStatus();
  const calls = capture();
  const sent = await notifyWhatsAppSenderQuarantine([unmarked], {
    env, now: 2000001440000, ...calls,
  });
  assert.equal(sent, true);
  assert.match(calls.messages[0], /unsupported_whatsapp_event/);
});

test("a forged internal marker with a different business number still alerts", async () => {
  const item = { ...secondaryStatus(), phoneNumberId: "199999999999999" };
  const calls = capture();
  assert.equal(await notifyWhatsAppSenderQuarantine([item], {
    env, now: 2000002160000, ...calls,
  }), true);
  assert.equal(calls.messages.length, 1);
});

test("a deferred receipt still alerts if receipt ingestion is active", async () => {
  const calls = capture();
  assert.equal(await notifyWhatsAppSenderQuarantine([secondaryStatus()], {
    env: { ...env, WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED: "true" },
    now: 2000002880000, ...calls,
  }), true);
  assert.equal(calls.messages.length, 1);
});

test("no silencing when secondary Inbox-only routing is disabled", async () => {
  const calls = capture();
  assert.equal(await notifyWhatsAppSenderQuarantine([secondaryStatus()], {
    env: { ...env, WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED: "false" },
    now: 2000003600000, ...calls,
  }), true);
  assert.equal(calls.messages.length, 1);
});

test("primary delivery statuses are still routed without quarantine", () => {
  const result = partition([{
    id: PRIMARY_ACCOUNT,
    changes: [{ field: "messages", value: {
      metadata: { phone_number_id: PRIMARY },
      statuses: [{ id: "wamid.primary.status", status: "delivered" }],
    } }],
  }]);
  assert.equal(result.quarantined.length, 0);
  assert.equal(result.acceptedActionable, 1);
  assert.equal(result.acceptedBody.entry[0].changes[0].value.statuses.length, 1);
});


test("quarantine database failure escalates even an otherwise routine status", async () => {
  const calls = capture();
  const sent = await notifyWhatsAppSenderQuarantine([secondaryStatus()], {
    env, auditFailed: true, now: 2000004320000, ...calls,
  });
  assert.equal(sent, true);
  assert.equal(calls.messages.length, 1);
  assert.match(calls.messages[0], /quarantine audit failed/);
  assert.match(calls.messages[0], /were not recorded successfully/);
  assert.equal(calls.warnings.length, 1);
});


test("sent, delivered and read statuses remain quiet and audit-compatible", async () => {
  let now = 2000006000000;
  for (const status of ["sent", "delivered", "read"]) {
    const item = secondaryStatus(status);
    assert.equal(item.expectedSecondaryStatus, true);
    assert.equal(item.secondaryStatusRequiresReview, false);
    assert.equal(item.field, "messages");
    assert.equal(item.reason, "unsupported_whatsapp_event");
    const calls = capture();
    assert.equal(await notifyWhatsAppSenderQuarantine([item], {
      env, now, ...calls,
    }), false);
    assert.equal(calls.messages.length, 0);
    now += 720000;
  }
});

test("failed status triggers a distinct delivery warning, not a missing-Inbox warning", async () => {
  const item = secondaryStatus("failed");
  assert.equal(item.expectedSecondaryStatus, false);
  assert.equal(item.secondaryStatusRequiresReview, true);
  const calls = capture();
  assert.equal(await notifyWhatsAppSenderQuarantine([item], {
    env, now: 2000009000000, ...calls,
  }), true);
  assert.equal(calls.messages.length, 1);
  assert.match(calls.messages[0], /Secondary WhatsApp delivery status needs review/);
  assert.doesNotMatch(calls.messages[0], /business-number routing alert/);
  assert.match(calls.warnings[0], /failed\/unrecognized receipt/);
  assert.equal(item.reason, "unsupported_whatsapp_event");
  assert.equal(item.field, "messages");
});

test("unknown status and success with error details also require delivery review", async () => {
  let now = 2000010000000;
  for (const item of [secondaryStatus("unknown-type"), secondaryStatus("sent", [{ code: 131000 }])]) {
    assert.equal(item.secondaryStatusRequiresReview, true);
    const calls = capture();
    assert.equal(await notifyWhatsAppSenderQuarantine([item], {
      env, now, ...calls,
    }), true);
    assert.match(calls.messages[0], /delivery status needs review/);
    now += 720000;
  }
});

test("secondary delivery errors are summarized per sender for ten minutes but all logged", async () => {
  const first = secondaryStatus("failed");
  const second = secondaryStatus("failed");
  const third = secondaryStatus("failed");
  const t = 2000013000000;
  const calls = capture();
  assert.equal(await notifyWhatsAppSenderQuarantine([first], {
    env, now: t, ...calls,
  }), true);
  assert.equal(await notifyWhatsAppSenderQuarantine([second], {
    env, now: t + 60000, ...calls,
  }), false);
  assert.equal(calls.messages.length, 1);
  assert.equal(calls.warnings.length, 2);
  assert.equal(await notifyWhatsAppSenderQuarantine([third], {
    env, now: t + 601000, ...calls,
  }), true);
  assert.equal(calls.messages.length, 2);
  assert.equal(calls.warnings.length, 3);
});

test("different routing incidents with the same reason both alert within ten minutes", async () => {
  const first = {
    fingerprint: "a".repeat(64), reason: "different_business_phone",
    field: "messages", accountId: "288888888888888", phoneNumberId: "188888888888888",
  };
  const second = { ...first, fingerprint: "b".repeat(64) };
  const t = 2000015000000;
  const calls = capture();
  assert.equal(await notifyWhatsAppSenderQuarantine([first], { env, now: t, ...calls }), true);
  assert.equal(await notifyWhatsAppSenderQuarantine([second], { env, now: t + 1000, ...calls }), true);
  assert.equal(calls.messages.length, 2);
  assert.match(calls.messages[0], /different_business_phone/);
  assert.match(calls.messages[1], /different_business_phone/);
  assert.equal(await notifyWhatsAppSenderQuarantine([first], {
    env, now: t + 720000, ...calls,
  }), false, "replaying one fingerprint must not generate a fresh alert");
  assert.equal(calls.messages.length, 2);
});

test("a failed status cannot suppress a distinct genuine routing failure", async () => {
  const t = 2000017000000;
  const receipt = secondaryStatus("failed");
  const foreign = {
    fingerprint: "c".repeat(64), reason: "different_business_account",
    field: "messages", accountId: "277777777777777", phoneNumberId: "177777777777777",
  };
  const calls = capture();
  assert.equal(await notifyWhatsAppSenderQuarantine([receipt, foreign], {
    env, now: t, ...calls,
  }), true);
  assert.equal(calls.messages.length, 2);
  assert.ok(calls.messages.some(msg => msg.includes("Secondary WhatsApp delivery status needs review")));
  assert.ok(calls.messages.some(msg => msg.includes("business-number routing alert")));
  const secondForeign = { ...foreign, fingerprint: "d".repeat(64) };
  assert.equal(await notifyWhatsAppSenderQuarantine([secondaryStatus("failed"), secondForeign], {
    env, now: t + 1000, ...calls,
  }), true);
  assert.equal(calls.messages.length, 3,
    "delivery summary is cooled down but an independent routing error still alerts");
});

test("a failed Telegram post does not consume the routing incident deduplication", async () => {
  const item = {
    fingerprint: "e".repeat(64), reason: "different_business_phone",
    field: "messages", accountId: "255555555555555", phoneNumberId: "155555555555555",
  };
  const warnings = [];
  const errors = [];
  const t = 2000019000000;
  assert.equal(await notifyWhatsAppSenderQuarantine([item], {
    env, now: t, post: async () => { throw Error("synthetic network outage"); },
    logger: { warn: msg => warnings.push(msg), error: msg => errors.push(msg) },
  }), false);
  assert.equal(errors.length, 1);
  const calls = capture();
  assert.equal(await notifyWhatsAppSenderQuarantine([item], {
    env, now: t + 1000, ...calls,
  }), true);
  assert.equal(calls.messages.length, 1);
});

test("mixed secondary customer text and failed status stays sender-scoped", () => {
  const body = { object: "whatsapp_business_account", entry: [{
    id: SECONDARY_ACCOUNT,
    changes: [{ field: "messages", value: {
      metadata: { phone_number_id: SECONDARY },
      messages: [{ id: "wamid.incoming", from: "60127777777", text: { body: "Hello" } }],
      statuses: [{ id: "wamid.secondary.failed", status: "failed" }],
    } }],
  }] };
  const result = partition(body.entry);
  assert.equal(result.acceptedActionable, 1);
  assert.equal(result.quarantined.length, 1);
  assert.equal(result.quarantined[0].secondaryStatusRequiresReview, true);
  const change = result.acceptedBody.entry[0].changes[0];
  assert.equal(change.value.messages[0].id, "wamid.incoming");
  assert.equal(Object.hasOwn(change.value, "statuses"), false,
    "secondary status never enters primary status or billing handlers");
});


test("malformed errors property is not mistaken for a routine success", async () => {
  const item = secondaryStatus("delivered", { code: 131000 });
  assert.equal(item.expectedSecondaryStatus, false);
  assert.equal(item.secondaryStatusRequiresReview, true);
  const calls = capture();
  assert.equal(await notifyWhatsAppSenderQuarantine([item], {
    env, now: 2000023000000, ...calls,
  }), true);
  assert.match(calls.messages[0], /delivery status needs review/);
});

test("one callback with multiple failures produces one summary with actual count", async () => {
  const a = secondaryStatus("failed");
  const b = secondaryStatus("failed");
  const calls = capture();
  assert.equal(await notifyWhatsAppSenderQuarantine([a, b], {
    env, now: 2000024000000, ...calls,
  }), true);
  assert.equal(calls.messages.length, 1);
  assert.match(calls.messages[0], /2 failed or unrecognized delivery-status event\(s\)/);
  assert.match(calls.warnings[0], /2 failed\/unrecognized receipt event\(s\)/);
});
