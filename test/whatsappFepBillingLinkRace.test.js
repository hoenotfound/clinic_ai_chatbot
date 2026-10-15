const test = require("node:test");
const assert = require("node:assert/strict");
const realtimeEvents = require("../src/utils/realtimeEvents");
const messagesRepo = require("../src/db/messagesRepo");
const { createWhatsAppDeliveryStatusService } =
  require("../src/services/whatsappDeliveryStatusService");

function fakeWhatsappLinkDatabase({
  pricingProof = true, failCommit = false, holdCommit = null,
} = {}) {
  const calls = [];
  let committed = false;
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === "COMMIT") {
        if (holdCommit) await holdCommit;
        if (failCommit) throw new Error("commit failed");
        committed = true;
      }
      if (sql.includes("UPDATE messages") && sql.includes("whatsapp_accepted_at")) {
        return { rows: [{ id: 22, contact_id: 7, whatsapp_message_id: "wamid.early" }] };
      }
      if (sql.includes("FROM whatsapp_free_entry_pricing_evidence")) {
        return { rows: pricingProof ? [{exists: true}] : [] };
      }
      return { rows: [] };
    },
    release() { calls.push("release"); },
  };
  return {
    database: { async connect() { return client; } },
    calls,
    get committed() { return committed; },
  };
}

test("callback-before-linking rechecks FEP eligibility again after the WAMID commit", async () => {
  const link = fakeWhatsappLinkDatabase();
  const received = [];
  const unsubscribe = realtimeEvents.subscribe("whatsapp_fep_billing_evidence",
    payload => received.push({payload, committed: link.committed}));
  const delivery = createWhatsAppDeliveryStatusService({
    repo: { async storeBatch() { return []; } },
    wakeResultMedia() {},
    reconcileFreeOnlyGate: async () => false,
  });
  try {
    await delivery.storeDeliveryStatusUpdates([{
      wamid: "wamid.early", pricingType: "free_entry_point",
      pricingBillable: false, status: "delivered",
    }]);
    assert.equal(received.length, 1, "pricing evidence callback wakes before MID exists");
    assert.equal(link.committed, false);
    await messagesRepo.setWhatsappMessageId(22, "wamid.early",
      { database: link.database, events: realtimeEvents });
    assert.equal(received.length, 2,
      "later durable WAMID association must cause a second eligibility recheck");
    assert.equal(received[1].payload.reason, "wamid_linked");
    assert.equal(received[1].payload.contactId, 7);
    assert.equal(received[1].committed, true,
      "link signal must never fire before the message ID commit");
    assert.ok(link.calls.indexOf("COMMIT") < link.calls.findIndex(
      sql => sql.includes("FROM whatsapp_free_entry_pricing_evidence")));
  } finally {
    unsubscribe();
  }
});

test("no proof, failed WAMID transaction and paused commits cannot falsely wake FEP", async () => {
  const received = [];
  const unsubscribe = realtimeEvents.subscribe("whatsapp_fep_billing_evidence",
    payload => received.push(payload));
  try {
    const noProof = fakeWhatsappLinkDatabase({ pricingProof: false });
    await messagesRepo.setWhatsappMessageId(22, "wamid.not-confirmed",
      { database: noProof.database });
    assert.equal(received.length, 0, "ordinary WhatsApp replies never wake FEP");

    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const delayed = fakeWhatsappLinkDatabase({holdCommit: gate});
    const link = messagesRepo.setWhatsappMessageId(22, "wamid.early",
      { database: delayed.database });
    // Wait for SQL chain to reach the COMMIT, but do not release it yet.
    for (let i = 0; i < 20 && !delayed.calls.includes("COMMIT"); i++) {
      await Promise.resolve();
    }
    assert.ok(delayed.calls.includes("COMMIT"));
    assert.equal(received.length, 0);
    release();
    await link;
    assert.equal(received.length, 1);

    const rolledBack = fakeWhatsappLinkDatabase({failCommit: true});
    await assert.rejects(
      messagesRepo.setWhatsappMessageId(22, "wamid.early",
        {database: rolledBack.database}), /commit failed/
    );
    assert.equal(received.length, 1);
    assert.ok(rolledBack.calls.includes("ROLLBACK"));
  } finally {
    unsubscribe();
  }
});
