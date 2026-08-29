const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db/db");
const telegramImmediateAlerts = require("../src/services/telegramImmediateAlertService");
const contactsRepo = require("../src/db/contactsRepo");

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("creates a contact with a race-safe insert", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /ON CONFLICT \(whatsapp_number\) DO NOTHING/);
    assert.deepEqual(params, ["60123456789", "Patient"]);
    return {
      rows: [{ id: 8, whatsapp_number: "60123456789", whatsapp_profile_name: "Patient" }],
    };
  };

  const contact = await contactsRepo.getOrCreateContact("60123456789", " Patient ");
  assert.equal(contact.id, 8);
});

test("human attention state triggers an immediate Telegram alert without blocking the database update", async (t) => {
  const originalQuery = pool.query;
  const originalAlert = telegramImmediateAlerts.sendHumanInterventionAlert;
  t.after(() => {
    pool.query = originalQuery;
    telegramImmediateAlerts.sendHumanInterventionAlert = originalAlert;
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
  telegramImmediateAlerts.sendHumanInterventionAlert = async (input) => {
    alert = input;
    return { status: "sent" };
  };

  const updated = await contactsRepo.setAttention(12, true, "AI handed off this conversation.");
  await nextTick();

  assert.equal(updated.id, 12);
  assert.deepEqual(alert, {
    contactId: 12,
    messageId: 44,
    reason: "AI handed off this conversation.",
  });
});

test("staff takeover keeps the existing human-intervention Telegram cooldown", async (t) => {
  const originalQuery = pool.query;
  const originalReset = telegramImmediateAlerts.resetHumanInterventionCooldown;
  t.after(() => {
    pool.query = originalQuery;
    telegramImmediateAlerts.resetHumanInterventionCooldown = originalReset;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /SET mode = 'human'/);
    assert.deepEqual(params, ["staff1", 12]);
    return { rows: [{ id: 12, mode: "human" }] };
  };

  let resetCalls = 0;
  telegramImmediateAlerts.resetHumanInterventionCooldown = async () => {
    resetCalls += 1;
  };

  const updated = await contactsRepo.takeOver(12, "staff1");
  assert.equal(updated.mode, "human");
  assert.equal(resetCalls, 0);
});

test("returning a handled conversation to AI resets the human-intervention Telegram cooldown", async (t) => {
  const originalQuery = pool.query;
  const originalReset = telegramImmediateAlerts.resetHumanInterventionCooldown;
  t.after(() => {
    pool.query = originalQuery;
    telegramImmediateAlerts.resetHumanInterventionCooldown = originalReset;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /SET mode = 'ai'/);
    assert.deepEqual(params, [12]);
    return { rows: [{ id: 12, mode: "ai" }] };
  };

  let resetContactId = null;
  telegramImmediateAlerts.resetHumanInterventionCooldown = async (contactId) => {
    resetContactId = contactId;
  };

  const updated = await contactsRepo.returnToAi(12);
  assert.equal(updated.mode, "ai");
  assert.equal(resetContactId, 12);
});

test("clearing attention resets the human-intervention Telegram cooldown", async (t) => {
  const originalQuery = pool.query;
  const originalReset = telegramImmediateAlerts.resetHumanInterventionCooldown;
  const originalAlert = telegramImmediateAlerts.sendHumanInterventionAlert;
  t.after(() => {
    pool.query = originalQuery;
    telegramImmediateAlerts.resetHumanInterventionCooldown = originalReset;
    telegramImmediateAlerts.sendHumanInterventionAlert = originalAlert;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /SET needs_attention = \$1/);
    assert.deepEqual(params, [false, null, 12]);
    return { rows: [{ id: 12, needs_attention: false }] };
  };

  let resetContactId = null;
  let alertCalls = 0;
  telegramImmediateAlerts.resetHumanInterventionCooldown = async (contactId) => {
    resetContactId = contactId;
  };
  telegramImmediateAlerts.sendHumanInterventionAlert = async () => {
    alertCalls += 1;
  };

  const updated = await contactsRepo.setAttention(12, false);
  assert.equal(updated.needs_attention, false);
  assert.equal(resetContactId, 12);
  assert.equal(alertCalls, 0);
});

test("cooldown reset failure does not block returning a conversation to AI", async (t) => {
  const originalQuery = pool.query;
  const originalReset = telegramImmediateAlerts.resetHumanInterventionCooldown;
  const originalConsoleError = console.error;
  t.after(() => {
    pool.query = originalQuery;
    telegramImmediateAlerts.resetHumanInterventionCooldown = originalReset;
    console.error = originalConsoleError;
  });

  pool.query = async () => ({ rows: [{ id: 12, mode: "ai" }] });
  telegramImmediateAlerts.resetHumanInterventionCooldown = async () => {
    throw new Error("database unavailable");
  };
  console.error = () => {};

  const updated = await contactsRepo.returnToAi(12);
  assert.equal(updated.mode, "ai");
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
    assert.deepEqual(params, ["Delivery failed: Meta rejected the message.", 12]);
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
