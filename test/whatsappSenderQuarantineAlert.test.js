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
function secondaryStatus() {
  const result = partition([{
    id: SECONDARY_ACCOUNT,
    changes: [{
      field: "messages",
      value: {
        metadata: { phone_number_id: SECONDARY },
        statuses: [{ id: "wamid.secondary.status", status: "delivered" }],
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
  assert.match(calls.messages[0], /database write did not complete/);
  assert.equal(calls.warnings.length, 1);
});
