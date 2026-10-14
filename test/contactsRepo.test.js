const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db/db");
const telegramImmediateAlerts = require("../src/services/telegramImmediateAlertService");
const webPushNotifications = require("../src/services/webPushNotificationService");
const contactsRepo = require("../src/db/contactsRepo");

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

const UPDATED_AT = "2026-08-29T07:15:00.000Z";

test("Inbox exposes the contact update version for stale Return-to-AI protection", async (t) => {
  const originalQuery = pool.query;
  t.after(() => { pool.query = originalQuery; });
  pool.query = async (sql) => {
    assert.match(sql, /c\.updated_at/);
    assert.match(sql, /c\.attention_reason/);
    return { rows: [] };
  };
  const rows = await contactsRepo.listConversations();
  assert.deepEqual(rows, []);
});


test("creates a canonical contact with a race-safe insert", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let queryCount = 0;
  pool.query = async (sql, params) => {
    queryCount += 1;
    if (queryCount === 1) {
      assert.match(sql, /UPDATE contacts AS legacy/);
      assert.match(sql, /NOT EXISTS/);
      assert.deepEqual(params, ["60123456789", "0123456789", "Patient"]);
      return { rows: [] };
    }

    assert.equal(queryCount, 2);
    assert.match(sql, /ON CONFLICT \(whatsapp_number\) DO NOTHING/);
    assert.deepEqual(params, ["60123456789", "Patient"]);
    return {
      rows: [{ id: 8, whatsapp_number: "60123456789", whatsapp_profile_name: "Patient" }],
    };
  };

  const contact = await contactsRepo.getOrCreateContact("60123456789", " Patient ");
  assert.equal(contact.id, 8);
  assert.equal(queryCount, 2);
});

test("reconciles a legacy Malaysian local-format contact before inserting a duplicate", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let queryCount = 0;
  pool.query = async (sql, params) => {
    queryCount += 1;
    assert.equal(queryCount, 1);
    assert.match(sql, /UPDATE contacts AS legacy/);
    assert.match(sql, /SET whatsapp_number = \$1/);
    assert.match(sql, /canonical\.whatsapp_number = \$1/);
    assert.deepEqual(params, ["60123456789", "0123456789", "Patient"]);
    return {
      rows: [{ id: 22, whatsapp_number: "60123456789", whatsapp_profile_name: "Patient" }],
    };
  };

  const contact = await contactsRepo.getOrCreateContact("+60 12-345 6789", "Patient");
  assert.equal(contact.id, 22);
  assert.equal(contact.whatsapp_number, "60123456789");
  assert.equal(queryCount, 1);
});

test("keeps an existing canonical contact instead of destructively merging a legacy duplicate", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let queryCount = 0;
  pool.query = async (sql, params) => {
    queryCount += 1;
    if (queryCount === 1) {
      assert.match(sql, /UPDATE contacts AS legacy/);
      return { rows: [] };
    }
    if (queryCount === 2) {
      assert.match(sql, /ON CONFLICT \(whatsapp_number\) DO NOTHING/);
      return { rows: [] };
    }
    assert.equal(queryCount, 3);
    assert.match(sql, /SET whatsapp_profile_name = \$2/);
    assert.deepEqual(params, ["60123456789", "Current Patient"]);
    return {
      rows: [{ id: 31, whatsapp_number: "60123456789", whatsapp_profile_name: "Current Patient" }],
    };
  };

  const contact = await contactsRepo.getOrCreateContact("60123456789", "Current Patient");
  assert.equal(contact.id, 31);
  assert.equal(queryCount, 3);
});

test("human attention state triggers an immediate Telegram alert without blocking the database update", async (t) => {
  const originalQuery = pool.query;
  const originalAlert = telegramImmediateAlerts.sendHumanInterventionAlert;
  const originalPush = webPushNotifications.sendContactAlertBestEffort;
  t.after(() => {
    pool.query = originalQuery;
    telegramImmediateAlerts.sendHumanInterventionAlert = originalAlert;
    webPushNotifications.sendContactAlertBestEffort = originalPush;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /SET needs_attention = \$1/);
    assert.match(sql, /AS attention_message_id/);
    assert.deepEqual(params, [true, "AI handed off this conversation.", 12]);
    return {
      rows: [{
        id: 12,
        attention_reason: "AI handed off this conversation.",
        attention_message_id: 44,
      }],
    };
  };

  let alert = null;
  let pushAlert = null;
  telegramImmediateAlerts.sendHumanInterventionAlert = async (input) => {
    alert = input;
    return { status: "sent" };
  };
  webPushNotifications.sendContactAlertBestEffort = (input) => {
    pushAlert = input;
  };

  const updated = await contactsRepo.setAttention(12, true, "AI handed off this conversation.");
  await nextTick();

  assert.equal(updated.id, 12);
  assert.deepEqual(alert, {
    contactId: 12,
    messageId: 44,
    reason: "AI handed off this conversation.",
  });
  assert.deepEqual(pushAlert, {
    contactId: 12,
    type: "human_intervention",
  });
});

test("routine Staff-mode attention can suppress Web Push without suppressing Telegram", async (t) => {
  const originalQuery = pool.query;
  const originalAlert = telegramImmediateAlerts.sendHumanInterventionAlert;
  const originalPush = webPushNotifications.sendContactAlertBestEffort;
  t.after(() => {
    pool.query = originalQuery;
    telegramImmediateAlerts.sendHumanInterventionAlert = originalAlert;
    webPushNotifications.sendContactAlertBestEffort = originalPush;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /SET needs_attention = \$1/);
    assert.deepEqual(params, [
      true,
      "New message — conversation is staff-owned.",
      12,
    ]);
    return {
      rows: [{
        id: 12,
        attention_reason: "New message — conversation is staff-owned.",
        attention_message_id: 45,
      }],
    };
  };

  let telegramCalls = 0;
  let pushCalls = 0;
  telegramImmediateAlerts.sendHumanInterventionAlert = async () => {
    telegramCalls += 1;
    return { status: "sent" };
  };
  webPushNotifications.sendContactAlertBestEffort = () => {
    pushCalls += 1;
  };

  const updated = await contactsRepo.setAttention(
    12,
    true,
    "New message — conversation is staff-owned.",
    { notifyWebPush: false }
  );
  await nextTick();

  assert.equal(updated.id, 12);
  assert.equal(telegramCalls, 1);
  assert.equal(pushCalls, 0);
});

test("strict cooldown has no application reset helper", () => {
  assert.equal(telegramImmediateAlerts.resetHumanInterventionCooldown, undefined);
});

test("staff takeover keeps the existing human-intervention Telegram cooldown", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /pg_advisory_xact_lock/);
    assert.match(sql, /current_contact AS MATERIALIZED/);
    assert.match(sql, /SET mode = 'human'/);
    assert.match(sql, /INSERT INTO follow_up_ai_decisions/);
    assert.doesNotMatch(sql, /anchor\.sent_by_username IS NULL/);
    assert.match(sql, /Cancelled because clinic staff took over this conversation/);
    assert.deepEqual(params, ["staff1", 12]);
    return { rows: [{ id: 12, mode: "human", updated_at: UPDATED_AT }] };
  };

  const updated = await contactsRepo.takeOver(12, "staff1");
  assert.equal(updated.mode, "human");
});

test("returning a conversation to AI does not reopen the strict cooldown", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /SET mode = 'ai'/);
    assert.deepEqual(params, [12, null]);
    return { rows: [{ id: 12, mode: "ai", updated_at: UPDATED_AT }] };
  };

  const updated = await contactsRepo.returnToAi(12);
  assert.equal(updated.mode, "ai");
});

test("clearing attention does not reopen the strict cooldown or send a new alert", async (t) => {
  const originalQuery = pool.query;
  const originalAlert = telegramImmediateAlerts.sendHumanInterventionAlert;
  t.after(() => {
    pool.query = originalQuery;
    telegramImmediateAlerts.sendHumanInterventionAlert = originalAlert;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /SET needs_attention = \$1/);
    assert.deepEqual(params, [false, null, 12]);
    return { rows: [{ id: 12, needs_attention: false, updated_at: UPDATED_AT }] };
  };

  let alertCalls = 0;
  telegramImmediateAlerts.sendHumanInterventionAlert = async () => {
    alertCalls += 1;
  };

  const updated = await contactsRepo.setAttention(12, false);
  assert.equal(updated.needs_attention, false);
  assert.equal(alertCalls, 0);
});

test("Staff Assist clears unread and attention only when the contact snapshot is unchanged", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  const snapshot = {
    id: 12,
    updated_at: UPDATED_AT,
    mode: "ai",
    takeover_by: null,
    needs_attention: true,
    attention_reason: "Needs review",
    is_unread: true,
  };

  pool.query = async (sql, params) => {
    assert.match(sql, /date_trunc\('milliseconds', updated_at\) = \$2::timestamptz/);
    assert.match(sql, /mode = \$3/);
    assert.match(sql, /takeover_by IS NOT DISTINCT FROM \$4/);
    assert.match(sql, /attention_reason IS NOT DISTINCT FROM \$6/);
    assert.deepEqual(params, [
      12,
      UPDATED_AT,
      "ai",
      null,
      true,
      "Needs review",
      true,
    ]);
    return { rows: [] };
  };

  const updated = await contactsRepo.clearStaffAssistStateIfUnchanged(snapshot);
  assert.equal(updated, null);
});

test("temporary AI outage attention clears only when that exact reason is still current", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /mode = 'ai'/);
    assert.match(sql, /attention_reason = \$2/);
    assert.deepEqual(params, [
      12,
      contactsRepo.TEMPORARY_AI_ATTENTION_REASON,
    ]);
    return {
      rows: [{
        id: 12,
        mode: "ai",
        needs_attention: false,
        attention_reason: null,
      }],
    };
  };

  const updated = await contactsRepo.clearTemporaryAiAttention(12);
  assert.equal(updated.needs_attention, false);
});

test("temporary AI outage attention does not clear a newer staff reason", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /attention_reason = \$2/);
    assert.deepEqual(params, [
      12,
      contactsRepo.TEMPORARY_AI_ATTENTION_REASON,
    ]);
    return { rows: [] };
  };

  const updated = await contactsRepo.clearTemporaryAiAttention(12);
  assert.equal(updated, null);
});

test("direct delivery warnings link only a validated failed assistant message", async (t) => {
  const originalQuery = pool.query;
  const originalAlert = telegramImmediateAlerts.sendDeliveryFailureAlert;
  t.after(() => {
    pool.query = originalQuery;
    telegramImmediateAlerts.sendDeliveryFailureAlert = originalAlert;
  });
  pool.query = async (sql, params) => {
    assert.match(sql, /delivery_attention_message_id = \(/);
    assert.match(sql, /m\.delivery_status IN \('failed','unknown'\)/);
    assert.match(sql, /m\.contact_id = contacts\.id/);
    assert.match(sql, /active_attempt\.created_at, active_attempt\.id/);
    assert.deepEqual(params, ["Delivery failed: an image was rejected", 99, 5003]);
    return { rows: [{ id: 99, needs_attention: true,
      delivery_attention_message_id: 5003 }] };
  };
  telegramImmediateAlerts.sendDeliveryFailureAlert = async () => ({
    status: "queued",
  });
  const alert = await contactsRepo.setDeliveryAttention(
    99, "Delivery failed: an image was rejected", 5003
  );
  assert.equal(alert.delivery_attention_message_id, 5003);
});

test("stale suppressed delivery attempt does not send Telegram or Web Push alerts", async (t) => {
  const oldQuery = pool.query;
  const oldTelegram = telegramImmediateAlerts.sendDeliveryFailureAlert;
  const oldPush = webPushNotifications.sendContactAlertBestEffort;
  t.after(() => {
    pool.query = oldQuery;
    telegramImmediateAlerts.sendDeliveryFailureAlert = oldTelegram;
    webPushNotifications.sendContactAlertBestEffort = oldPush;
  });

  let calls = 0;
  pool.query = async (sql, params) => {
    calls++;
    if (calls === 1) {
      assert.match(sql, /delivery_attention_message_id = \(/);
      assert.deepEqual(params, ["Delivery failed: stale photo", 72, 9001]);
      // An older failure has already been superseded by a newer alert.
      return { rows: [] };
    }
    assert.equal(calls, 2);
    assert.match(sql, /AS actionable/);
    assert.match(sql, /unresolved|failed\.delivery_status IN \('failed', 'unknown'\)/);
    assert.match(sql, /c\.delivery_attention_message_id IS NOT NULL/);
    assert.deepEqual(params, [72, 9001]);
    return { rows: [{ actionable: false }] };
  };

  const emitted = [];
  telegramImmediateAlerts.sendDeliveryFailureAlert = async (args) => {
    emitted.push(["telegram", args]);
  };
  webPushNotifications.sendContactAlertBestEffort = (args) => {
    emitted.push(["push", args]);
  };

  assert.equal(await contactsRepo.setDeliveryAttention(
    72, "Delivery failed: stale photo", 9001
  ), null);
  await nextTick();
  assert.equal(calls, 2);
  assert.deepEqual(emitted, [], "a suppressed older failure must be silent");
});

test("actionable failure behind protected clinical attention still sends Telegram and Web Push", async (t) => {
  const oldQuery = pool.query;
  const oldTelegram = telegramImmediateAlerts.sendDeliveryFailureAlert;
  const oldPush = webPushNotifications.sendContactAlertBestEffort;
  t.after(() => {
    pool.query = oldQuery;
    telegramImmediateAlerts.sendDeliveryFailureAlert = oldTelegram;
    webPushNotifications.sendContactAlertBestEffort = oldPush;
  });

  let calls = 0;
  pool.query = async (sql, params) => {
    calls++;
    if (calls === 1) {
      assert.match(sql, /attention_reason LIKE 'Delivery failed:%'/);
      assert.deepEqual(params, ["Delivery failed: current photo", 73, 9002]);
      // A clinical/booking warning takes precedence over delivery attention.
      return { rows: [] };
    }
    assert.equal(calls, 2);
    assert.match(sql, /AS actionable/);
    assert.deepEqual(params, [73, 9002]);
    return { rows: [{ actionable: true }] };
  };

  const emitted = [];
  telegramImmediateAlerts.sendDeliveryFailureAlert = async ({contactId,reason}) => {
    emitted.push(["telegram", contactId, reason]);
    return { status: "sent" };
  };
  webPushNotifications.sendContactAlertBestEffort = ({contactId,type}) => {
    emitted.push(["push", contactId, type]);
  };

  assert.equal(await contactsRepo.setDeliveryAttention(
    73, "Delivery failed: current photo", 9002
  ), null);
  await nextTick();
  assert.equal(calls, 2);
  assert.deepEqual(emitted, [
    ["telegram", 73, "Delivery failed: current photo"],
    ["push", 73, "delivery_failure"]
  ]);
});

test("delivery failures alert Telegram even when a higher-priority attention reason prevents replacing the contact flag", async (t) => {
  const originalQuery = pool.query;
  const originalAlert = telegramImmediateAlerts.sendDeliveryFailureAlert;
  t.after(() => {
    pool.query = originalQuery;
    telegramImmediateAlerts.sendDeliveryFailureAlert = originalAlert;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /attention_reason LIKE 'Delivery failed:%'/);
    assert.deepEqual(params, ["Delivery failed: Meta rejected the message.", 12, null]);
    assert.match(sql, /delivery_attention_message_id/);
    return { rows: [] };
  };

  let alert = null;
  telegramImmediateAlerts.sendDeliveryFailureAlert = async (input) => {
    alert = input;
    return { status: "sent" };
  };

  const updated = await contactsRepo.setDeliveryAttention(
    12,
    "Delivery failed: Meta rejected the message."
  );
  await nextTick();

  assert.equal(updated, null);
  assert.deepEqual(alert, {
    contactId: 12,
    reason: "Delivery failed: Meta rejected the message.",
  });
});
