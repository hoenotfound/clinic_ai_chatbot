const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db/db");
const telegramImmediateAlerts = require("../src/services/telegramImmediateAlertService");
const contactsRepo = require("../src/db/contactsRepo");

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

const UPDATED_AT = "2026-08-29T07:15:00.000Z";

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

test("strict cooldown has no application reset helper", () => {
  assert.equal(telegramImmediateAlerts.resetHumanInterventionCooldown, undefined);
});

test("staff takeover keeps the existing human-intervention Telegram cooldown", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /SET mode = 'human'/);
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
    assert.deepEqual(params, [12]);
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
