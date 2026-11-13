"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const marketing = require("../src/services/whatsappSecondaryMarketingFollowUpService");

test("extended secondary follow-ups isolate unsettled reservations by customer", () => {
  for (const sql of [
    marketing.EXTENDED_CANDIDATES_SQL,
    marketing.EXTENDED_RECHECK_SQL,
    marketing.EXTENDED_POTENTIAL_DUE_SQL,
  ]) {
    assert.match(sql, /gate\.owner_contact_id=c\.id/);
    assert.match(sql, /gate\.state IN \('reserved','awaiting_pricing'\)/);
    assert.match(sql, /whatsapp_sender_billing_alarms alarm WHERE alarm\.sender_id=sa\.id/);
    assert.match(sql, /bad\.contact_id=c\.id/);
  }
});
